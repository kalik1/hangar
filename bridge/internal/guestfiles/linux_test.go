package guestfiles

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/fakeagent"
)

func mkfile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o640); err != nil {
		t.Fatal(err)
	}
}

func TestE2EListSmall(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, "a.txt"), []byte("hello"))
	mkfile(t, filepath.Join(dir, "with\ttab and\nnewline"), nil)
	mkfile(t, filepath.Join(dir, "jérôme ✓"), []byte("x"))
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir, "sub"), 0o2750|os.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("a.txt", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}

	var list v1alpha1.GuestFileList
	e.decode(e.do(http.MethodGet, q("op", "list", "path", dir+"//"), nil), http.StatusOK, &list)
	if list.Kind != "GuestFileList" || list.Partial || list.Cursor != "" {
		t.Errorf("%+v", list)
	}
	byName := map[string]v1alpha1.GuestFile{}
	for _, f := range list.Entries {
		byName[f.Name] = f
	}
	if len(byName) != 5 {
		t.Fatalf("entries %+v", list.Entries)
	}
	a := byName["a.txt"]
	if a.Type != v1alpha1.FileTypeFile || a.Size != 5 || a.Mode == nil || *a.Mode != 0o640 || a.UID == nil || a.MTime == "" {
		t.Errorf("a.txt %+v", a)
	}
	if sub := byName["sub"]; sub.Type != v1alpha1.FileTypeDirectory || *sub.Mode != 0o2750 {
		t.Errorf("sub %+v mode %o", sub, *sub.Mode)
	}
	if l := byName["link"]; l.Type != v1alpha1.FileTypeSymlink {
		t.Errorf("link %+v", l)
	}
	names := []string{"jérôme ✓", "with\ttab and\nnewline"}
	if !gnuFind() {
		// busybox ls prints "?" for a control character.
		names = names[:1]
	}
	for _, n := range names {
		if _, ok := byName[n]; !ok {
			t.Errorf("no %q in %v", n, list.Entries)
		}
	}
	if left, _ := os.ReadDir(e.tmp); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
}

func TestE2EListPages(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	for i := range 120 {
		mkfile(t, filepath.Join(dir, "f"+strconv.Itoa(i)), nil)
	}
	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		params := q("op", "list", "path", dir, "limit", "50")
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		var list v1alpha1.GuestFileList
		e.decode(e.do(http.MethodGet, params, nil), http.StatusOK, &list)
		pages++
		if len(list.Entries) > 50 {
			t.Fatalf("a page of %d", len(list.Entries))
		}
		for _, f := range list.Entries {
			if seen[f.Name] {
				t.Errorf("%s twice", f.Name)
			}
			seen[f.Name] = true
		}
		if list.Cursor == "" {
			break
		}
		left, _ := os.ReadDir(e.tmp)
		if len(left) != 1 {
			t.Errorf("the listing's temporary files: %v", left)
		}
		cursor = list.Cursor
	}
	if pages != 3 || len(seen) != 120 {
		t.Errorf("%d pages, %d entries", pages, len(seen))
	}
	if left, _ := os.ReadDir(e.tmp); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
	for _, n := range e.agent.ReadCounts() {
		if n != agent.MaxFileRead {
			t.Errorf("a guest-file-read of %d", n)
		}
	}
	if e.agent.OpenFiles() != 0 {
		t.Error("a handle left open")
	}
}

func TestE2EListCursors(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	for i := range 10 {
		mkfile(t, filepath.Join(dir, "f"+strconv.Itoa(i)), nil)
	}
	var list v1alpha1.GuestFileList
	e.decode(e.do(http.MethodGet, q("op", "list", "path", dir, "limit", "4"), nil), http.StatusOK, &list)
	if list.Cursor == "" {
		t.Fatal("no cursor")
	}
	// Another path's listing does not take it.
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir+"/x", "cursor", list.Cursor), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir, "cursor", "bm90IGEgY3Vyc29y"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)

	// The listing is gone: 410.
	files, _ := os.ReadDir(e.tmp)
	for _, f := range files {
		_ = os.Remove(filepath.Join(e.tmp, f.Name()))
	}
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir, "cursor", list.Cursor), nil), http.StatusGone, v1alpha1.CauseExpired)
}

func TestE2EListErrors(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, "file"), nil)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir+"/file"), nil), http.StatusConflict, v1alpha1.CauseNotADirectory)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir+"/missing"), nil), http.StatusNotFound, v1alpha1.CauseNotFound)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", "relative"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir+"/../etc"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", dir, "limit", "5001"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
}

// TestE2EListPartial: find's status 1 (SELinux hides entries) is a partial
// listing, on every page.
func TestE2EListPartial(t *testing.T) {
	a := &fakeagent.Agent{}
	e := newE2E(t, a)
	dir := t.TempDir()
	for i := range 6 {
		mkfile(t, filepath.Join(dir, "f"+strconv.Itoa(i)), nil)
	}
	// The script runs as it is, with a find (or an ls) that fails on one
	// entry of the listing.
	bin := t.TempDir()
	for tool, listing := range map[string]string{"find": " -mindepth 1 ", "ls": " -lAn "} {
		real, err := exec.LookPath(tool)
		if err != nil {
			t.Fatal(err)
		}
		mkfile(t, filepath.Join(bin, tool), []byte("#!/bin/sh\n"+real+" \"$@\"; s=$?\ncase \" $* \" in *'"+listing+
			"'*) echo \""+tool+": '/x/hidden': Permission denied\" >&2; exit 1;; esac\nexit $s\n"))
		if err := os.Chmod(filepath.Join(bin, tool), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	a.Exec = func(path string, args []string) ([]byte, []byte, int) {
		args = slices.Clone(args)
		args[1] = replaceFirst(args[1], "PATH=/usr/local/sbin", "PATH="+bin+":/usr/local/sbin")
		return fakeagent.Local(path, args)
	}
	for _, limit := range []string{"10", "4"} {
		var list v1alpha1.GuestFileList
		e.decode(e.do(http.MethodGet, q("op", "list", "path", dir, "limit", limit), nil), http.StatusOK, &list)
		if !list.Partial || list.PartialReason == "" || len(list.Entries) == 0 {
			t.Fatalf("limit %s: %+v", limit, list)
		}
		if limit == "4" {
			var next v1alpha1.GuestFileList
			e.decode(e.do(http.MethodGet, q("op", "list", "path", dir, "cursor", list.Cursor, "limit", "4"), nil), http.StatusOK, &next)
			if !next.Partial || next.PartialReason != list.PartialReason || len(next.Entries) != 2 {
				t.Errorf("the next page: %+v", next)
			}
		}
	}
}

// gnuFind reports whether this host's find has -printf, as the scripts
// check.
func gnuFind() bool {
	return exec.Command("find", "/", "-maxdepth", "0", "-printf", "").Run() == nil
}

func replaceFirst(s, old, new string) string {
	i := bytes.Index([]byte(s), []byte(old))
	if i < 0 {
		return s
	}
	return s[:i] + new + s[i+len(old):]
}

func TestE2EStat(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, "f"), []byte("12345"))
	if err := os.Symlink("f", filepath.Join(dir, "l")); err != nil {
		t.Fatal(err)
	}
	var fi v1alpha1.GuestFileInfo
	e.decode(e.do(http.MethodGet, q("op", "stat", "path", dir+"/f"), nil), http.StatusOK, &fi)
	if fi.Kind != "GuestFileInfo" || fi.Name != "f" || fi.Size != 5 || fi.Type != v1alpha1.FileTypeFile {
		t.Errorf("%+v", fi)
	}
	e.decode(e.do(http.MethodGet, q("op", "stat", "path", dir+"/l"), nil), http.StatusOK, &fi)
	if fi.Type != v1alpha1.FileTypeSymlink {
		t.Errorf("a link is followed: %+v", fi)
	}
	e.failure(e.do(http.MethodGet, q("op", "stat", "path", dir+"/missing"), nil), http.StatusNotFound, v1alpha1.CauseNotFound)
}

func TestE2EReadWrite(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	data := make([]byte, 5<<20+12345)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	path := dir + "/up.bin"

	// Upload in 1 MiB calls: the first truncates.
	for off := 0; off < len(data); off += v1alpha1.MaxWriteBody {
		end := min(off+v1alpha1.MaxWriteBody, len(data))
		params := q("op", "write", "path", path, "offset", strconv.Itoa(off))
		if off == 0 {
			params.Set("truncate", "true")
		}
		var res v1alpha1.GuestFileWrite
		e.decode(e.do(http.MethodPut, params, data[off:end]), http.StatusOK, &res)
		if res.Written != int64(end-off) || res.Size != int64(end) {
			t.Fatalf("offset %d: %+v", off, res)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("the file differs (%d bytes, %v)", len(got), err)
	}
	for _, n := range e.agent.WriteSizes() {
		if n > agent.MaxFileWrite {
			t.Errorf("a guest-file-write of %d bytes", n)
		}
	}
	for _, c := range e.server.Calls() {
		if len(c.Cmd) > 180_000 {
			t.Errorf("an agent command of %d bytes", len(c.Cmd))
		}
	}

	// One Event for the file, when the upload goes idle.
	if ev := e.rec.take(); len(ev) != 0 {
		t.Errorf("Events before the upload ends: %v", ev)
	}
	e.clk.Step(DefaultWriteIdle)
	ev := e.rec.take()
	if len(ev) != 1 || ev[0].reason != ReasonWritten || ev[0].message != `user "alice" wrote `+path+": "+strconv.Itoa(len(data))+" bytes" {
		t.Errorf("Events %v", ev)
	}

	// Download in 3 MiB calls of 1 MiB guest-file-reads.
	var down []byte
	for off := 0; ; {
		w := e.do(http.MethodGet, q("op", "read", "path", path, "offset", strconv.Itoa(off)), nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		if w.Header().Get("Content-Type") != "application/octet-stream" || w.Header().Get(v1alpha1.HeaderFileSize) != strconv.Itoa(len(data)) ||
			w.Header().Get(v1alpha1.HeaderFileMTime) == "" || w.Header().Get(v1alpha1.HeaderFileOffset) != strconv.Itoa(off) {
			t.Errorf("headers %v", w.Header())
		}
		if w.Body.Len() > v1alpha1.MaxReadLength {
			t.Fatalf("a read of %d", w.Body.Len())
		}
		down = append(down, w.Body.Bytes()...)
		off += w.Body.Len()
		if w.Header().Get(v1alpha1.HeaderFileEOF) == "true" {
			break
		}
	}
	if !bytes.Equal(down, data) {
		t.Fatalf("the download differs: %d bytes", len(down))
	}
	for _, n := range e.agent.ReadCounts() {
		if n > agent.MaxFileRead {
			t.Errorf("a guest-file-read of %d", n)
		}
	}

	var h v1alpha1.GuestFileHash
	e.decode(e.do(http.MethodGet, q("op", "hash", "path", path), nil), http.StatusOK, &h)
	sum := sha256.Sum256(data)
	if h.Hash != hex.EncodeToString(sum[:]) || h.Algorithm != "sha256" || h.Size != int64(len(data)) || h.MTime == "" {
		t.Errorf("%+v", h)
	}
	if e.agent.OpenFiles() != 0 {
		t.Error("a handle left open")
	}
	if ev := e.rec.take(); len(ev) != 0 {
		t.Errorf("reads recorded Events: %v", ev)
	}
}

func TestE2EWriteChecks(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	mkfile(t, dir+"/f", []byte("1234"))

	e.failure(e.do(http.MethodPut, q("op", "write", "path", dir+"/f", "offset", "5"), []byte("x")), http.StatusConflict, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodPut, q("op", "write", "path", dir+"/f", "offset", "1", "truncate", "true"), []byte("x")), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodPut, q("op", "write", "path", dir+"/new", "offset", "0"), []byte("x")), http.StatusNotFound, v1alpha1.CauseNotFound)
	e.failure(e.do(http.MethodPut, q("op", "write", "path", dir, "truncate", "true"), []byte("x")), http.StatusConflict, v1alpha1.CauseIsADirectory)
	w := e.do(http.MethodPut, q("op", "write", "path", dir+"/f", "truncate", "true"), make([]byte, v1alpha1.MaxWriteBody+1))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
	e.failure(e.do(http.MethodGet, q("op", "read", "path", dir), nil), http.StatusConflict, v1alpha1.CauseIsADirectory)
	e.failure(e.do(http.MethodGet, q("op", "read", "path", dir+"/f", "length", strconv.Itoa(v1alpha1.MaxReadLength+1)), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)

	// Appending at the end, and writing in place.
	var res v1alpha1.GuestFileWrite
	e.decode(e.do(http.MethodPut, q("op", "write", "path", dir+"/f", "offset", "4"), []byte("56")), http.StatusOK, &res)
	e.decode(e.do(http.MethodPut, q("op", "write", "path", dir+"/f", "offset", "0"), []byte("ab")), http.StatusOK, &res)
	if got, _ := os.ReadFile(dir + "/f"); string(got) != "ab3456" || res.Size != 6 {
		t.Errorf("%q %+v", got, res)
	}
	// An empty body with truncate empties the file.
	e.decode(e.do(http.MethodPut, q("op", "write", "path", dir+"/f", "truncate", "true"), []byte{}), http.StatusOK, &res)
	if got, _ := os.ReadFile(dir + "/f"); len(got) != 0 || res.Size != 0 {
		t.Errorf("%q %+v", got, res)
	}
	// A file of /proc has no size, and bytes all the same.
	w = e.do(http.MethodGet, q("op", "read", "path", "/proc/self/status"), nil)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("Pid:")) || w.Header().Get(v1alpha1.HeaderFileEOF) != "true" {
		t.Errorf("/proc/self/status: %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	// Past the end of the file, a read is empty.
	w = e.do(http.MethodGet, q("op", "read", "path", dir+"/f", "offset", "10"), nil)
	if w.Code != http.StatusOK || w.Body.Len() != 0 || w.Header().Get(v1alpha1.HeaderFileEOF) != "true" {
		t.Errorf("%d %q %v", w.Code, w.Body.String(), w.Header())
	}
}

func TestE2EChanges(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()

	var fi v1alpha1.GuestFileInfo
	e.decode(e.do(http.MethodPost, q("op", "mkdir", "path", dir+"/a/b"), nil), http.StatusCreated, &fi)
	if fi.Type != v1alpha1.FileTypeDirectory || fi.Name != "b" {
		t.Errorf("%+v", fi)
	}
	e.decode(e.do(http.MethodPost, q("op", "mkdir", "path", dir+"/a/b"), nil), http.StatusOK, &fi)
	e.failure(e.do(http.MethodPost, q("op", "mkdir", "path", dir+"/a/b", "exclusive", "true"), nil), http.StatusConflict, v1alpha1.CauseAlreadyExists)

	e.decode(e.do(http.MethodPost, q("op", "create", "path", dir+"/a/f", "exclusive", "true"), nil), http.StatusCreated, &fi)
	if fi.Type != v1alpha1.FileTypeFile || fi.Size != 0 {
		t.Errorf("%+v", fi)
	}
	e.failure(e.do(http.MethodPost, q("op", "create", "path", dir+"/a/f", "exclusive", "true"), nil), http.StatusConflict, v1alpha1.CauseAlreadyExists)
	e.failure(e.do(http.MethodPost, q("op", "create", "path", dir+"/a/b"), nil), http.StatusConflict, v1alpha1.CauseIsADirectory)
	mkfile(t, dir+"/a/f", []byte("data"))
	e.decode(e.do(http.MethodPost, q("op", "create", "path", dir+"/a/f"), nil), http.StatusCreated, &fi)
	if fi.Size != 0 {
		t.Errorf("not emptied: %+v", fi)
	}

	mkfile(t, dir+"/a/g", []byte("g"))
	e.failure(e.do(http.MethodPost, q("op", "rename", "from", dir+"/a/f", "to", dir+"/a/g", "exclusive", "true"), nil), http.StatusConflict, v1alpha1.CauseAlreadyExists)
	e.failure(e.do(http.MethodPost, q("op", "rename", "from", dir+"/a/f", "to", dir+"/a/b"), nil), http.StatusConflict, v1alpha1.CauseIsADirectory)
	e.failure(e.do(http.MethodPost, q("op", "rename", "from", dir+"/a/missing", "to", dir+"/a/x"), nil), http.StatusNotFound, v1alpha1.CauseNotFound)
	e.decode(e.do(http.MethodPost, q("op", "rename", "from", dir+"/a/f", "to", dir+"/a/g"), nil), http.StatusOK, &fi)
	if fi.Name != "g" || fi.Size != 0 {
		t.Errorf("%+v", fi)
	}

	uid := strconv.Itoa(os.Getuid())
	e.decode(e.do(http.MethodPost, q("op", "chown", "path", dir+"/a/g", "owner", uid, "group", strconv.Itoa(os.Getgid())), nil), http.StatusOK, &fi)
	if fi.UID == nil || strconv.FormatInt(*fi.UID, 10) != uid {
		t.Errorf("%+v", fi)
	}
	e.failure(e.do(http.MethodPost, q("op", "chown", "path", dir+"/a/g", "owner", "-R"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodPost, q("op", "chown", "path", dir+"/a/g"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)

	e.failure(e.do(http.MethodDelete, q("op", "delete", "path", dir+"/a"), nil), http.StatusConflict, v1alpha1.CauseDirectoryNotEmpty)
	e.failure(e.do(http.MethodDelete, q("op", "delete", "path", "/", "recursive", "true"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.decode(e.do(http.MethodDelete, q("op", "delete", "path", dir+"/a/g"), nil), http.StatusOK, nil)
	e.decode(e.do(http.MethodDelete, q("op", "delete", "path", dir+"/a", "recursive", "true"), nil), http.StatusOK, nil)
	if _, err := os.Stat(dir + "/a"); !os.IsNotExist(err) {
		t.Errorf("not deleted: %v", err)
	}
	e.failure(e.do(http.MethodDelete, q("op", "delete", "path", dir+"/a"), nil), http.StatusNotFound, v1alpha1.CauseNotFound)

	var reasons []string
	for _, ev := range e.rec.take() {
		reasons = append(reasons, ev.reason)
	}
	want := []string{ReasonDirectoryCreated, ReasonCreated, ReasonCreated, ReasonRenamed, ReasonOwnerChanged, ReasonDeleted, ReasonDeleted}
	if !slices.Equal(reasons, want) {
		t.Errorf("Events %v, want %v", reasons, want)
	}
}

// TestE2EBlocked: Rocky's allow-list disables guest-exec and guest-file-*:
// every op answers Blocked, and none of them reaches the agent.
func TestE2EBlocked(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{Disabled: []string{
		agent.CmdExec, agent.CmdExecStatus, agent.CmdFileOpen, agent.CmdFileClose, agent.CmdFileRead,
		agent.CmdFileWrite, agent.CmdFileSeek, "guest-file-flush"}})
	for _, c := range []struct {
		method string
		params []string
	}{
		{http.MethodGet, []string{"op", "list", "path", "/"}},
		{http.MethodGet, []string{"op", "stat", "path", "/etc"}},
		{http.MethodGet, []string{"op", "read", "path", "/etc/hostname"}},
		{http.MethodGet, []string{"op", "hash", "path", "/etc/hostname"}},
		{http.MethodPut, []string{"op", "write", "path", "/var/tmp/x", "truncate", "true"}},
		{http.MethodPost, []string{"op", "mkdir", "path", "/var/tmp/d"}},
		{http.MethodDelete, []string{"op", "delete", "path", "/var/tmp/x"}},
	} {
		st := e.failure(e.do(c.method, q(c.params...), []byte("x")), http.StatusForbidden, v1alpha1.CauseBlocked)
		if st.Details.Causes[0].Field == "" || st.Message == "" {
			t.Errorf("%v: %+v", c.params, st)
		}
	}
	for _, cmd := range e.commands() {
		if cmd != agent.CmdInfo && cmd != agent.CmdGetOSInfo {
			t.Errorf("called %s", cmd)
		}
	}
}

// TestE2EVerbs: each op takes one verb, and only its own parameters.
func TestE2EVerbs(t *testing.T) {
	e := newE2E(t, &fakeagent.Agent{})
	for op, spec := range ops {
		for method, verb := range methodVerbs {
			if verb == spec.verb {
				continue
			}
			w := e.do(method, q("op", op, "path", "/tmp"), nil)
			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s op=%s: %d %s", method, op, w.Code, w.Body.String())
			}
		}
	}
	e.failure(e.do(http.MethodGet, q("op", "exec", "path", "/"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodGet, q("op", "stat", "path", "/", "command", "id"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.failure(e.do(http.MethodGet, q("path", "/"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	if got := e.commands(); len(got) != 0 {
		t.Errorf("called %v", got)
	}
}

// TestE2EListDenied: what root (or an unconfined agent) never meets, and a
// confined agent does: a directory whose entries cannot be looked at is a
// partial listing (find exits 1); one that cannot be read at all is
// PermissionDenied. It needs a user that permissions stop: CI's.
func TestE2EListDenied(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root reads every directory")
	}
	e := newE2E(t, &fakeagent.Agent{})
	dir := t.TempDir()
	for _, n := range []string{"a", "b"} {
		mkfile(t, filepath.Join(dir, "names-only", n), nil)
	}
	if err := os.Mkdir(filepath.Join(dir, "closed"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		dir  string
		mode os.FileMode
	}{{"names-only", 0o444}, {"closed", 0}} {
		if err := os.Chmod(filepath.Join(dir, c.dir), c.mode); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(filepath.Join(dir, c.dir), 0o755) })
	}

	var list v1alpha1.GuestFileList
	e.decode(e.do(http.MethodGet, q("op", "list", "path", dir+"/names-only"), nil), http.StatusOK, &list)
	if !list.Partial || len(list.Entries) != 0 || !strings.Contains(list.PartialReason, "could not read 2 entries") {
		t.Errorf("%+v", list)
	}
	st := e.failure(e.do(http.MethodGet, q("op", "list", "path", dir+"/closed"), nil), http.StatusForbidden, v1alpha1.CausePermissionDenied)
	if !strings.Contains(st.Message, "SELinux") {
		t.Errorf("no hint: %s", st.Message)
	}
	e.failure(e.do(http.MethodPut, q("op", "write", "path", dir+"/closed/x", "truncate", "true"), []byte("x")), http.StatusForbidden, v1alpha1.CausePermissionDenied)
	e.failure(e.do(http.MethodPost, q("op", "mkdir", "path", dir+"/closed/d"), nil), http.StatusForbidden, v1alpha1.CausePermissionDenied)
}
