package guestfiles

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	clocktesting "k8s.io/utils/clock/testing"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/guest"
)

func TestCleanPath(t *testing.T) {
	for in, want := range map[string]string{
		"/":              "/",
		"//":             "/",
		"/etc/":          "/etc",
		"/var//tmp/x":    "/var/tmp/x",
		"/a b/ç/\tc":     "/a b/ç/\tc",
		"/.hidden/..x":   "/.hidden/..x",
		"/-rf":           "/-rf",
		"/home/k4all/..": "",
		"/home/./x":      "",
		"relative":       "",
		"":               "",
		"/a\x00b":        "",
		"/\xff":          "",
		"C:\\Windows":    "",
	} {
		got, err := cleanPath("path", in, false)
		if (err != nil) != (want == "") || got != want {
			t.Errorf("Linux %q: %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := cleanPath("path", "/"+strings.Repeat("a", agent.MaxPath), false); err == nil {
		t.Error("a path over MaxPath")
	}
	for in, want := range map[string]string{
		`C:\`:                      `C:\`,
		`c:/Users/k4all/x.txt`:     `C:\Users\k4all\x.txt`,
		`D:\a\\b\`:                 `D:\a\b`,
		`C:\Program Files (x86)\é`: `C:\Program Files (x86)\é`,
		`C:\a\..\Windows`:          "",
		`C:\a?b`:                   "",
		`C:\a:stream`:              "",
		`\\server\share`:           "",
		`/etc`:                     "",
		`C:`:                       "",
		"C:\\a\x01":                "",
	} {
		got, err := cleanPath("path", in, true)
		if (err != nil) != (want == "") || got != want {
			t.Errorf("Windows %q: %q, %v; want %q", in, got, err, want)
		}
	}
	if !isRoot("/", false) || !isRoot(`C:\`, true) || isRoot("/etc", false) || isRoot(`C:\x`, true) {
		t.Error("isRoot")
	}
	if !under("/a/b", "/a", false) || under("/ab", "/a", false) || !under("/a", "/a", false) || !under(`C:\a\b`, `C:\a`, true) {
		t.Error("under")
	}
}

func TestValidOwner(t *testing.T) {
	for _, ok := range []string{"", "root", "1000", "k4all", "first.last", "user@example.com", "DOMAIN\\user", "svc_x-1$"} {
		if err := validOwner("owner", ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"-R", "a:b", "a b", "a/b", "a\nb", "é", strings.Repeat("a", 257)} {
		if err := validOwner("owner", bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestCursor(t *testing.T) {
	c := cursor{Version: cursorVersion, Path: pathHash("/etc"), Tool: toolFind, File: "hangar-ls.Ab3dE6gH9k", Offset: 4096,
		Partial: true, Reason: strings.Repeat("r", 2000)}
	s := c.encode()
	got, err := decodeCursor(s, "/etc", false)
	if err != nil || got.File != c.File || got.Offset != 4096 || !got.Partial || len(got.Reason) != maxCursorReason {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := decodeCursor(s, "/usr", false); err == nil {
		t.Error("another path's cursor")
	}
	if _, err := decodeCursor(s, "/etc", true); err == nil {
		t.Error("a Linux cursor on Windows")
	}
	for _, bad := range []cursor{
		{Version: cursorVersion, Path: pathHash("/etc"), Tool: toolFind, File: "../../etc/shadow"},
		{Version: cursorVersion, Path: pathHash("/etc"), Tool: toolFind, File: "hangar-ls.Ab3dE6gH9k/x"},
		{Version: cursorVersion, Path: pathHash("/etc"), Tool: "cat", File: "hangar-ls.Ab3dE6gH9k"},
		{Version: cursorVersion, Path: pathHash("/etc"), Tool: toolFind, File: "hangar-ls.Ab3dE6gH9k", Offset: -1},
		{Version: 2, Path: pathHash("/etc"), Tool: toolFind, File: "hangar-ls.Ab3dE6gH9k"},
	} {
		if _, err := decodeCursor(bad.encode(), "/etc", false); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	w := cursor{Version: cursorVersion, Path: pathHash(`C:\`), Skip: 5000}.encode()
	if got, err := decodeCursor(w, `C:\`, true); err != nil || got.Skip != 5000 {
		t.Errorf("%+v %v", got, err)
	}
	if _, err := decodeCursor(w, `C:\`, false); err == nil {
		t.Error("a Windows cursor on Linux")
	}
	if _, err := decodeCursor("%%%", "/etc", false); err == nil {
		t.Error("not base64")
	}
}

// TestUploads: the write calls of one file are one Event, with the size,
// when no write came for the idle time; a write at offset 0 that truncates
// starts another; a delete of the file, or the bridge stopping, records it
// at once.
func TestUploads(t *testing.T) {
	rec := &memRecorder{}
	clk := clocktesting.NewFakeClock(t0)
	u := newUploads(rec, 10*time.Second, clk)
	vm := guest.Target{Namespace: "vms", Name: "vm", UID: "uid-1"}
	other := guest.Target{Namespace: "vms", Name: "other", UID: "uid-2"}

	for i := range 100 {
		u.wrote(vm, `user "alice"`, "/var/tmp/big", 1<<20, int64(i+1)<<20, i == 0)
		clk.Step(time.Second)
	}
	u.wrote(other, `user "alice"`, "/var/tmp/big", 5, 5, true)
	if ev := rec.take(); len(ev) != 0 {
		t.Fatalf("Events before the idle time: %v", ev)
	}
	clk.Step(10 * time.Second)
	ev := rec.take()
	if len(ev) != 2 || ev[0].reason != ReasonWritten {
		t.Fatalf("%v", ev)
	}
	msgs := ev[0].message + "|" + ev[1].message
	if !strings.Contains(msgs, `user "alice" wrote /var/tmp/big: 104857600 bytes`) || !strings.Contains(msgs, `user "alice" wrote /var/tmp/big: 5 bytes`) {
		t.Errorf("%v", ev)
	}

	// Two saves of the same file: two Events.
	u.wrote(vm, `user "alice"`, "/home/k4all/a.docx", 10, 10, true)
	u.wrote(vm, `user "alice"`, "/home/k4all/a.docx", 12, 12, true)
	if ev := rec.take(); len(ev) != 1 || !strings.HasSuffix(ev[0].message, ": 10 bytes") {
		t.Errorf("the first save: %v", ev)
	}
	u.finish("uid-1", func(p string) bool { return under(p, "/home/k4all", false) })
	if ev := rec.take(); len(ev) != 1 || !strings.HasSuffix(ev[0].message, ": 12 bytes") {
		t.Errorf("the second save, at a delete: %v", ev)
	}
	// An upload that resumes (on the bridge of the node a VM moved to, say)
	// says what it wrote of the file.
	u.wrote(vm, `user "alice"`, "/home/k4all/a.docx", 3, 15, false)
	clk.Step(10 * time.Second)
	if ev := rec.take(); len(ev) != 1 || ev[0].message != `user "alice" wrote 3 bytes of /home/k4all/a.docx, which is 15 bytes now` {
		t.Errorf("%v", ev)
	}
	u.wrote(vm, `user "bob"`, "/srv/x", 1, 1, true)
	u.close()
	if ev := rec.take(); len(ev) != 1 || !strings.Contains(ev[0].message, `user "bob"`) {
		t.Errorf("%v", ev)
	}
	u.wrote(vm, `user "bob"`, "/srv/x", 1, 1, true)
	if ev := rec.take(); len(ev) != 1 {
		t.Errorf("after close: %v", ev)
	}
	clk.Step(time.Minute)
	if ev := rec.take(); len(ev) != 0 {
		t.Errorf("a timer after the Event: %v", ev)
	}
}

func TestStatusError(t *testing.T) {
	for _, tc := range []struct {
		err   error
		code  int32
		cause string
	}{
		{agent.BlockedError(agent.CmdExec), http.StatusForbidden, v1alpha1.CauseBlocked},
		{&agent.Error{Command: agent.CmdFileRead, Reason: agent.Timeout}, http.StatusGatewayTimeout, v1alpha1.CauseTimeout},
		{&agent.Error{Command: agent.CmdExec, Reason: agent.NotResponding}, http.StatusServiceUnavailable, v1alpha1.CauseNotResponding},
		{&agent.Error{Command: agent.CmdExec, Reason: agent.NotConnected}, http.StatusServiceUnavailable, v1alpha1.CauseNotConnected},
		{&agent.Error{Command: agent.CmdExec, Reason: agent.NotSupported}, http.StatusNotImplemented, v1alpha1.CauseNotSupported},
		{&agent.Error{Command: agent.CmdExec, Reason: agent.AgentError}, http.StatusInternalServerError, v1alpha1.CauseAgentError},
		{failed(v1alpha1.CauseNotFound, "path", "x"), http.StatusNotFound, v1alpha1.CauseNotFound},
		{failed(v1alpha1.CauseAlreadyExists, "path", "x"), http.StatusConflict, v1alpha1.CauseAlreadyExists},
		{failed(v1alpha1.CauseExpired, "cursor", "x"), http.StatusGone, v1alpha1.CauseExpired},
		{failed(v1alpha1.CauseNoSpace, "path", "x"), http.StatusInsufficientStorage, v1alpha1.CauseNoSpace},
		{invalid("limit", "x"), http.StatusBadRequest, v1alpha1.CauseInvalid},
		{&fileError{cause: v1alpha1.CauseInvalid, field: "offset", code: http.StatusConflict}, http.StatusConflict, v1alpha1.CauseInvalid},
		{agent.ErrConnectionLost, http.StatusServiceUnavailable, ""},
	} {
		var st *apierrors.StatusError
		if !errors.As(statusError(tc.err), &st) {
			t.Errorf("%v: not a status", tc.err)
			continue
		}
		cause := ""
		if st.ErrStatus.Details != nil && len(st.ErrStatus.Details.Causes) > 0 {
			cause = string(st.ErrStatus.Details.Causes[0].Type)
		}
		if st.ErrStatus.Code != tc.code || cause != tc.cause {
			t.Errorf("%v: %d %q, want %d %q", tc.err, st.ErrStatus.Code, cause, tc.code, tc.cause)
		}
	}
}

// TestGuestCause: the guests' words for each errno, in GNU, busybox, dash,
// bash and Windows.
func TestGuestCause(t *testing.T) {
	for msg, want := range map[string]string{
		"find: '/x': No such file or directory":                                               v1alpha1.CauseNotFound,
		"sh: 1: cannot open /x: No such file":                                                 v1alpha1.CauseNotFound,
		"sh: 1: cannot create /a/b: Directory nonexistent":                                    v1alpha1.CauseNotFound,
		"failed to open file '/root/x' (mode: 'w'): Permission denied":                        v1alpha1.CausePermissionDenied,
		"chown: changing ownership of '/x': Operation not permitted":                          v1alpha1.CausePermissionDenied,
		"mkdir: cannot create directory '/x': File exists":                                    v1alpha1.CauseAlreadyExists,
		"sh: /x: cannot overwrite existing file":                                              v1alpha1.CauseAlreadyExists,
		"rmdir: failed to remove '/x': Directory not empty":                                   v1alpha1.CauseDirectoryNotEmpty,
		"rmdir: '/x': Directory not empty":                                                    v1alpha1.CauseDirectoryNotEmpty,
		"mv: cannot move '/a' to '/b/c': Not a directory":                                     v1alpha1.CauseNotADirectory,
		"failed to open file '/etc' (mode: 'w'): Is a directory":                              v1alpha1.CauseIsADirectory,
		"failed to write to file: No space left on device":                                    v1alpha1.CauseNoSpace,
		"touch: cannot touch '/usr/x': Read-only file system":                                 v1alpha1.CauseReadOnly,
		"Cannot find path 'C:\\x' because it does not exist.":                                 v1alpha1.CauseNotFound,
		"Access to the path 'C:\\Windows\\System32\\config' is denied.":                       v1alpha1.CausePermissionDenied,
		"The file 'C:\\x' already exists.":                                                    v1alpha1.CauseAlreadyExists,
		"failed to open file 'C:\\x' (mode: 'r'): The system cannot find the file specified.": v1alpha1.CauseNotFound,
		"something else": "",
	} {
		if got := guestCause(msg); got != want {
			t.Errorf("%q: %q, want %q", msg, got, want)
		}
	}
}
