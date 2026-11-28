package guestfiles

import (
	"context"
	"fmt"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	corev1client "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/klog/v2"
	"k8s.io/utils/clock"

	"github.com/kalik1/hangar/bridge/internal/guest"
)

// The reasons of the Events the bridge records on a VMI, one per file
// changed: who (the user as the API server forwarded it), what and the
// size. Reads leave none.
const (
	ReasonWritten          = "GuestFileWritten"
	ReasonCreated          = "GuestFileCreated"
	ReasonDirectoryCreated = "GuestDirectoryCreated"
	ReasonRenamed          = "GuestFileRenamed"
	ReasonOwnerChanged     = "GuestFileOwnerChanged"
	ReasonDeleted          = "GuestFileDeleted"
)

// Recorder records a change in a VM's guest.
type Recorder interface {
	Record(t guest.Target, reason, message string)
}

// EventComponent is the Events' source.
const EventComponent = "hangar-guest-bridge"

// maxEventMessage bounds an Event's message, as events.k8s.io bounds its
// note.
const maxEventMessage = 1024

// KubeRecorder writes each change as a core/v1 Event on the VMI, Normal,
// with the bridge's node as its source host. It writes them one by one,
// never aggregated: the trail is one Event per file.
type KubeRecorder struct {
	Events corev1client.EventsGetter
	Node   string
	Clock  clock.PassiveClock
}

// Record implements Recorder. A failure is logged: the change is made.
func (r *KubeRecorder) Record(t guest.Target, reason, message string) {
	c := r.Clock
	if c == nil {
		c = clock.RealClock{}
	}
	if len(message) > maxEventMessage {
		message = message[:maxEventMessage-3] + "..."
	}
	now := metav1.NewTime(c.Now())
	ev := &corev1.Event{
		ObjectMeta: metav1.ObjectMeta{GenerateName: t.Name + ".", Namespace: t.Namespace},
		InvolvedObject: corev1.ObjectReference{
			APIVersion: "kubevirt.io/v1",
			Kind:       "VirtualMachineInstance",
			Namespace:  t.Namespace,
			Name:       t.Name,
			UID:        t.UID,
		},
		Reason:              reason,
		Message:             message,
		Type:                corev1.EventTypeNormal,
		Source:              corev1.EventSource{Component: EventComponent, Host: r.Node},
		FirstTimestamp:      now,
		LastTimestamp:       now,
		Count:               1,
		ReportingController: EventComponent,
		ReportingInstance:   r.Node,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := r.Events.Events(t.Namespace).Create(ctx, ev, metav1.CreateOptions{}); err != nil {
		klog.ErrorS(err, "Recording a guest file change", "vmi", t.String(), "reason", reason, "message", message)
	}
}

// DefaultWriteIdle is how long after its last write call an upload's Event
// is recorded: a file goes up in many calls of 1 MiB, and gets one Event.
const DefaultWriteIdle = 10 * time.Second

// uploads gathers the write calls of each file into one Event: an upload
// starts at a write at offset 0 that truncates, takes every later write of
// the same user to the same file, and is recorded when no write came for
// the idle time, when the file is renamed or deleted, or when the bridge
// stops.
type uploads struct {
	rec   Recorder
	idle  time.Duration
	clock clock.WithDelayedExecution

	mu    sync.Mutex
	open  map[uploadKey]*upload
	ended bool
}

type uploadKey struct {
	vmi  types.UID
	path string
	user string
}

type upload struct {
	target  guest.Target
	user    string
	path    string
	written int64
	size    int64
	timer   clock.Timer
	// gen counts the writes: a timer ends the upload only if no write came
	// after the one that set it.
	gen int
}

func newUploads(rec Recorder, idle time.Duration, c clock.WithDelayedExecution) *uploads {
	if idle <= 0 {
		idle = DefaultWriteIdle
	}
	if c == nil {
		c = clock.RealClock{}
	}
	return &uploads{rec: rec, idle: idle, clock: c, open: map[uploadKey]*upload{}}
}

// wrote adds a write call of n bytes, after which the file is size bytes.
// fresh is a write that starts the file again (offset 0, truncate).
func (u *uploads) wrote(t guest.Target, user, path string, n, size int64, fresh bool) {
	key := uploadKey{t.UID, path, user}
	u.mu.Lock()
	if u.ended {
		u.mu.Unlock()
		u.rec.Record(t, ReasonWritten, writtenMessage(user, path, n, size))
		return
	}
	var done *upload
	up := u.open[key]
	if up != nil && fresh {
		done = u.remove(key)
		up = nil
	}
	if up == nil {
		up = &upload{target: t, user: user, path: path}
		u.open[key] = up
	} else {
		up.timer.Stop()
	}
	up.written += n
	up.size = size
	up.gen++
	gen := up.gen
	up.timer = u.clock.AfterFunc(u.idle, func() { u.end(key, up, gen) })
	u.mu.Unlock()
	u.record(done)
}

// end records the upload if it is still the open one of its key and no
// write came since the timer was set.
func (u *uploads) end(key uploadKey, up *upload, gen int) {
	u.mu.Lock()
	if u.open[key] != up || up.gen != gen {
		u.mu.Unlock()
		return
	}
	delete(u.open, key)
	u.mu.Unlock()
	u.record(up)
}

// remove takes the key's upload out, under u.mu.
func (u *uploads) remove(key uploadKey) *upload {
	up := u.open[key]
	if up != nil {
		up.timer.Stop()
		delete(u.open, key)
	}
	return up
}

// finish records the open uploads of a VMI's path, before an operation
// that renames or deletes it (or what is under it).
func (u *uploads) finish(vmi types.UID, under func(path string) bool) {
	u.mu.Lock()
	var done []*upload
	for key := range u.open {
		if key.vmi == vmi && under(key.path) {
			done = append(done, u.remove(key))
		}
	}
	u.mu.Unlock()
	for _, up := range done {
		u.record(up)
	}
}

// close records every open upload; later writes are recorded one by one.
func (u *uploads) close() {
	u.mu.Lock()
	u.ended = true
	var done []*upload
	for key := range u.open {
		done = append(done, u.remove(key))
	}
	u.mu.Unlock()
	for _, up := range done {
		u.record(up)
	}
}

func (u *uploads) record(up *upload) {
	if up == nil {
		return
	}
	u.rec.Record(up.target, ReasonWritten, writtenMessage(up.user, up.path, up.written, up.size))
}

func writtenMessage(user, path string, written, size int64) string {
	if written == size {
		return fmt.Sprintf("%s wrote %s: %s", user, path, bytesText(size))
	}
	return fmt.Sprintf("%s wrote %s of %s, which is %s now", user, bytesText(written), path, bytesText(size))
}

func bytesText(n int64) string {
	if n == 1 {
		return "1 byte"
	}
	return fmt.Sprintf("%d bytes", n)
}

// userName is the caller's name for an Event.
func userName(call guest.Call) string {
	if call.User == nil || call.User.GetName() == "" {
		return "an unknown user"
	}
	return fmt.Sprintf("user %q", call.User.GetName())
}
