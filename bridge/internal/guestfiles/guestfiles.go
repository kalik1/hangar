// Package guestfiles serves the guestfiles subresource: file operations in a
// VM's guest, through its guest agent (see v1alpha1's guestfiles.go for the
// calls and their answers).
//
// Reads and writes are guest-file-* calls, chunked to the limits the
// prototype measured: 1 MiB per guest-file-read, 128 KiB per
// guest-file-write. Everything else is a script of the bridge's own,
// run with guest-exec, with the client's values as its arguments only.
// Every call reads guest-info first (kept for a few seconds): a command it
// lists as disabled, as Rocky's default allow-list does, answers Blocked
// before any is sent.
//
// Each change (a file written, created, renamed, chowned or deleted, a
// directory made) records one Event on the VMI, with the user, the path and
// the size; a file written in many calls records one.
package guestfiles

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/utils/clock"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/guest"
)

// DefaultBudget bounds one call, under the API server's 60 s request
// timeout.
const DefaultBudget = 55 * time.Second

// How long a script may run: a listing (find of one directory) or a
// quick change, and a hash or a recursive delete, which read or walk a lot.
const (
	execWait = 30 * time.Second
	longWait = 50 * time.Second
)

// listInlineMax bounds the bytes of entries a listing's reply carries; a
// longer listing is paged from a temporary file. 1.5 MiB is 2 MiB of base64,
// under the 2.9 MB measured to be safe for a guest-exec-status reply.
const listInlineMax = 3 << 19

// VMSource gives the agent of a VMI on this node: agent.Pool.
type VMSource interface {
	VM(ctx context.Context, t guest.Target) (*agent.VM, error)
}

// Handler serves guestfiles.
type Handler struct {
	VMs VMSource
	// Events records the changes; nil records none.
	Events Recorder
	// Clock is the bridge's clock, for the Events' grouping and the
	// guest-info cache. Nil is the real clock.
	Clock clock.WithDelayedExecution
	// TempDir is the guest's directory for long listings; empty is
	// /var/tmp. Tests set their own.
	TempDir string
	// Budget bounds a call; zero is DefaultBudget.
	Budget time.Duration
	// WriteIdle is how long after an upload's last write its Event is
	// recorded; zero is DefaultWriteIdle.
	WriteIdle time.Duration

	once    sync.Once
	clock   clock.WithDelayedExecution
	uploads *uploads
	states  states
}

var _ guest.Handler = (*Handler)(nil)

func (h *Handler) init() {
	h.once.Do(func() {
		h.clock = h.Clock
		if h.clock == nil {
			h.clock = clock.RealClock{}
		}
		rec := h.Events
		if rec == nil {
			rec = nopRecorder{}
		}
		h.uploads = newUploads(rec, h.WriteIdle, h.clock)
	})
}

// Close records the Events of the uploads still open. The bridge calls it
// when it stops.
func (h *Handler) Close() {
	h.init()
	h.uploads.close()
}

type nopRecorder struct{}

func (nopRecorder) Record(guest.Target, string, string) {}

// ops are the operations, with their verb and the parameters each takes.
var ops = map[string]struct {
	verb   string
	params []string
}{
	v1alpha1.OpList:   {"get", []string{"path", "cursor", "limit"}},
	v1alpha1.OpStat:   {"get", []string{"path"}},
	v1alpha1.OpRead:   {"get", []string{"path", "offset", "length"}},
	v1alpha1.OpHash:   {"get", []string{"path"}},
	v1alpha1.OpWrite:  {"update", []string{"path", "offset", "truncate"}},
	v1alpha1.OpCreate: {"create", []string{"path", "exclusive"}},
	v1alpha1.OpMkdir:  {"create", []string{"path", "exclusive"}},
	v1alpha1.OpRename: {"create", []string{"from", "to", "exclusive"}},
	v1alpha1.OpChown:  {"create", []string{"path", "owner", "group"}},
	v1alpha1.OpDelete: {"delete", []string{"path", "recursive"}},
}

var verbMethods = map[string]string{"get": http.MethodGet, "create": http.MethodPost, "update": http.MethodPut, "delete": http.MethodDelete}

// ServeGuest implements guest.Handler.
func (h *Handler) ServeGuest(w http.ResponseWriter, r *http.Request, call guest.Call) {
	h.init()
	q := r.URL.Query()
	op, err := checkParams(q, call.Verb)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	budget := h.Budget
	if budget <= 0 {
		budget = DefaultBudget
	}
	ctx, cancel := context.WithTimeout(r.Context(), budget)
	defer cancel()

	vm, err := h.VMs.VM(ctx, call.Target)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	st, err := h.state(ctx, vm)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	s := &session{h: h, ctx: ctx, vm: vm, st: st, call: call, user: userName(call)}
	if err := s.serve(w, r, op, q); err != nil {
		if agent.ReasonOf(err) == agent.Blocked {
			h.forget(vm)
		}
		h.fail(w, r, err)
	}
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return // the caller went away
	}
	guest.WriteError(w, statusError(err))
}

// checkParams checks the op, its verb and that every parameter is one the
// op takes, given once.
func checkParams(q url.Values, verb string) (string, error) {
	op := q.Get("op")
	spec, ok := ops[op]
	if !ok {
		return "", invalid("op", fmt.Sprintf("op %q: the ops are list, stat, read, hash (GET), write (PUT), "+
			"create, mkdir, rename, chown (POST) and delete (DELETE)", op))
	}
	if spec.verb != verb {
		return "", apierrors.NewMethodNotSupported(
			schema.GroupResource{Group: v1alpha1.GroupName, Resource: v1alpha1.Resource + "/" + v1alpha1.SubresourceGuestFiles},
			fmt.Sprintf("%s for op=%s, which is %s", verb, op, verbMethods[spec.verb]))
	}
	for name, values := range q {
		switch {
		case name == "op" || name == "timeout" || name == "pretty":
		case !contains(spec.params, name):
			return "", invalid(name, fmt.Sprintf("op=%s takes no parameter %q", op, name))
		}
		if len(values) > 1 {
			return "", invalid(name, fmt.Sprintf("the parameter %q is given %d times", name, len(values)))
		}
	}
	return op, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func boolParam(q url.Values, name string) (bool, error) {
	v := q.Get(name)
	if v == "" {
		return false, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, invalid(name, fmt.Sprintf("%s: %q is not true or false", name, v))
	}
	return b, nil
}

func intParam(q url.Values, name string, def, lo, hi int64) (int64, error) {
	v := q.Get(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < lo || n > hi {
		return 0, invalid(name, fmt.Sprintf("%s: %q is not a number from %d to %d", name, v, lo, hi))
	}
	return n, nil
}

// session is one call's work on one VM.
type session struct {
	h    *Handler
	ctx  context.Context
	vm   *agent.VM
	st   *vmState
	call guest.Call
	user string
}

// windows is the guest's OS: the agent's word, or the path's form when the
// agent did not say.
func (s *session) windows(path string) bool {
	if s.st.osKnown {
		return s.st.windows
	}
	return looksWindows(path)
}

func (s *session) path(q url.Values, name string) (string, error) {
	return cleanPath(name, q.Get(name), s.windows(q.Get(name)))
}

func (s *session) serve(w http.ResponseWriter, r *http.Request, op string, q url.Values) error {
	if op == v1alpha1.OpRename {
		return s.serveRename(w, q)
	}
	path, err := s.path(q, "path")
	if err != nil {
		return err
	}
	win := s.windows(q.Get("path"))
	switch op {
	case v1alpha1.OpList:
		limit, err := intParam(q, "limit", v1alpha1.MaxListLimit, 1, v1alpha1.MaxListLimit)
		if err != nil {
			return err
		}
		var cur *cursor
		if c := q.Get("cursor"); c != "" {
			if cur, err = decodeCursor(c, path, win); err != nil {
				return err
			}
		}
		list, err := s.list(path, win, cur, int(limit))
		if err != nil {
			return err
		}
		list.TypeMeta = typeMeta("GuestFileList")
		guest.WriteObject(w, http.StatusOK, list)
	case v1alpha1.OpStat:
		e, err := s.stat(path, win, false)
		if err != nil {
			return err
		}
		guest.WriteObject(w, http.StatusOK, info(e))
	case v1alpha1.OpHash:
		hash, err := s.hash(path, win)
		if err != nil {
			return err
		}
		hash.TypeMeta = typeMeta("GuestFileHash")
		guest.WriteObject(w, http.StatusOK, hash)
	case v1alpha1.OpRead:
		offset, err := intParam(q, "offset", 0, 0, 1<<62)
		if err != nil {
			return err
		}
		length, err := intParam(q, "length", v1alpha1.MaxReadLength, 1, v1alpha1.MaxReadLength)
		if err != nil {
			return err
		}
		return s.read(w, path, win, offset, length)
	case v1alpha1.OpWrite:
		offset, err := intParam(q, "offset", 0, 0, 1<<62)
		if err != nil {
			return err
		}
		truncate, err := boolParam(q, "truncate")
		if err != nil {
			return err
		}
		body, err := readBody(r)
		if err != nil {
			return err
		}
		res, err := s.write(path, win, offset, truncate, body)
		if err != nil {
			return err
		}
		res.TypeMeta = typeMeta("GuestFileWrite")
		guest.WriteObject(w, http.StatusOK, res)
	case v1alpha1.OpCreate, v1alpha1.OpMkdir:
		exclusive, err := boolParam(q, "exclusive")
		if err != nil {
			return err
		}
		var e *v1alpha1.GuestFile
		created := true
		if op == v1alpha1.OpCreate {
			e, err = s.create(path, win, exclusive)
		} else {
			e, created, err = s.mkdir(path, win, exclusive)
		}
		if err != nil {
			return err
		}
		code := http.StatusCreated
		if !created {
			code = http.StatusOK
		}
		guest.WriteObject(w, code, info(e))
	case v1alpha1.OpChown:
		owner, group := q.Get("owner"), q.Get("group")
		if err := validOwner("owner", owner); err != nil {
			return err
		}
		if err := validOwner("group", group); err != nil {
			return err
		}
		if owner == "" && group == "" {
			return invalid("owner", "chown needs an owner, a group or both")
		}
		e, err := s.chown(path, win, owner, group)
		if err != nil {
			return err
		}
		guest.WriteObject(w, http.StatusOK, info(e))
	case v1alpha1.OpDelete:
		recursive, err := boolParam(q, "recursive")
		if err != nil {
			return err
		}
		if isRoot(path, win) {
			return invalid("path", fmt.Sprintf("path: the bridge does not delete %s", path))
		}
		if err := s.remove(path, win, recursive); err != nil {
			return err
		}
		guest.WriteObject(w, http.StatusOK, &metav1.Status{
			TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"},
			Status:   metav1.StatusSuccess,
			Code:     http.StatusOK,
			Message:  "deleted " + path,
		})
	}
	return nil
}

func (s *session) serveRename(w http.ResponseWriter, q url.Values) error {
	win := s.windows(q.Get("from"))
	from, err := cleanPath("from", q.Get("from"), win)
	if err != nil {
		return err
	}
	to, err := cleanPath("to", q.Get("to"), win)
	if err != nil {
		return err
	}
	exclusive, err := boolParam(q, "exclusive")
	if err != nil {
		return err
	}
	switch {
	case isRoot(from, win):
		return invalid("from", fmt.Sprintf("from: the bridge does not rename %s", from))
	case isRoot(to, win):
		return invalid("to", fmt.Sprintf("to: the bridge does not rename onto %s", to))
	case from == to:
		return invalid("to", "to: the same path as from")
	}
	e, err := s.rename(from, to, win, exclusive)
	if err != nil {
		return err
	}
	guest.WriteObject(w, http.StatusOK, info(e))
	return nil
}

func typeMeta(kind string) metav1.TypeMeta {
	return metav1.TypeMeta{Kind: kind, APIVersion: v1alpha1.SchemeGroupVersion.String()}
}

func info(e *v1alpha1.GuestFile) *v1alpha1.GuestFileInfo {
	return &v1alpha1.GuestFileInfo{Kind: "GuestFileInfo", APIVersion: v1alpha1.SchemeGroupVersion.String(), GuestFile: *e}
}

// record records a change, if the handler records any.
func (s *session) record(reason, message string) {
	if s.h.Events != nil {
		s.h.Events.Record(s.call.Target, reason, message)
	}
}
