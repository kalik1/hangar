package guestfiles

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/fakeagent"
)

// psGuest stands for a Windows guest: it decodes the PowerShell command
// line the bridge sends, checks it runs one of the bridge's scripts, and
// does what that script does on a directory of this host that is C:\.
type psGuest struct {
	root string

	mu     sync.Mutex
	params []map[string]any
}

var psParams = regexp.MustCompile(`^\$A = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\) \| ConvertFrom-Json\n`)

func (g *psGuest) host(p string) string {
	if len(p) < 3 || p[:3] != `C:\` {
		return filepath.Join(g.root, "not-on-C")
	}
	return filepath.Join(g.root, filepath.FromSlash(strings.ReplaceAll(p[3:], `\`, "/")))
}

func psEntryOf(name string, fi fs.FileInfo) map[string]any {
	y, s := "f", fi.Size()
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		y, s = "l", 0
	case fi.IsDir():
		y, s = "d", 0
	}
	return map[string]any{"n": name, "y": y, "s": s, "m": fi.ModTime().UTC().Format("2006-01-02T15:04:05.0000000Z")}
}

func (g *psGuest) exec(path string, args []string) ([]byte, []byte, int) {
	if path != "powershell.exe" || len(args) != 4 || args[0] != "-NoProfile" || args[1] != "-NonInteractive" || args[2] != "-EncodedCommand" {
		return nil, []byte(fmt.Sprintf("not the bridge's PowerShell: %s %q", path, args)), 1
	}
	text, err := agent.DecodePowerShell(args[3])
	if err != nil {
		return nil, []byte(err.Error()), 1
	}
	m := psParams.FindStringSubmatch(text)
	if m == nil {
		return nil, []byte("no parameters line"), 1
	}
	raw, _ := base64.StdEncoding.DecodeString(m[1])
	var a map[string]any
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, []byte(err.Error()), 1
	}
	g.mu.Lock()
	g.params = append(g.params, a)
	g.mu.Unlock()
	p, _ := a["path"].(string)
	out := func(v any) ([]byte, []byte, int) {
		b, _ := json.Marshal(v)
		return append([]byte("\xef\xbb\xbf"), b...), nil, 0
	}
	fail := func(code int, msg string) ([]byte, []byte, int) { return nil, []byte(msg), code }
	missing := func(p string) ([]byte, []byte, int) {
		return fail(2, fmt.Sprintf("Cannot find path '%s' because it does not exist.", p))
	}
	switch text[len(m[0]):] {
	case psListScript:
		fi, err := os.Stat(g.host(p))
		if err != nil {
			return missing(p)
		}
		if !fi.IsDir() {
			return fail(20, p+": Not a directory")
		}
		des, _ := os.ReadDir(g.host(p))
		sort.Slice(des, func(i, j int) bool { return strings.ToLower(des[i].Name()) < strings.ToLower(des[j].Name()) })
		skip, limit := int(a["skip"].(float64)), int(a["limit"].(float64))
		var entries []any
		i := skip
		for ; i < len(des) && len(entries) < limit; i++ {
			fi, _ := des[i].Info()
			entries = append(entries, psEntryOf(des[i].Name(), fi))
		}
		var next any
		if i < len(des) {
			next = i
		}
		if len(entries) == 1 {
			// Windows PowerShell 5.1 may print one object for an array of one.
			return out(map[string]any{"entries": entries[0], "next": next, "errors": 0, "error": ""})
		}
		return out(map[string]any{"entries": entries, "next": next, "errors": 0, "error": ""})
	case psStatScript:
		fi, err := os.Lstat(g.host(p))
		if err != nil {
			return missing(p)
		}
		return out(psEntryOf(filepath.Base(g.host(p)), fi))
	case psHashScript:
		fi, err := os.Stat(g.host(p))
		if err != nil {
			return missing(p)
		}
		if fi.IsDir() {
			return fail(21, p+": Is a directory")
		}
		b, _ := os.ReadFile(g.host(p))
		sum := sha256.Sum256(b)
		e := psEntryOf(fi.Name(), fi)
		e["h"] = strings.ToUpper(hex.EncodeToString(sum[:]))
		return out(e)
	case psMkdirScript:
		if fi, err := os.Stat(g.host(p)); err == nil {
			if a["exclusive"] == true || !fi.IsDir() {
				return fail(17, p+": File exists")
			}
			return out(map[string]any{"created": false, "entry": psEntryOf(fi.Name(), fi)})
		}
		_ = os.MkdirAll(g.host(p), 0o755)
		fi, _ := os.Stat(g.host(p))
		return out(map[string]any{"created": true, "entry": psEntryOf(fi.Name(), fi)})
	case psCreateScript:
		fl := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
		if a["exclusive"] == true {
			fl = os.O_WRONLY | os.O_CREATE | os.O_EXCL
		}
		f, err := os.OpenFile(g.host(p), fl, 0o644)
		if err != nil {
			return fail(1, fmt.Sprintf("Exception calling \"Open\" with \"3\" argument(s): \"The file '%s' already exists.\"", p))
		}
		f.Close()
		fi, _ := os.Stat(g.host(p))
		return out(psEntryOf(fi.Name(), fi))
	case psRenameScript:
		from, to := a["from"].(string), a["to"].(string)
		if _, err := os.Stat(g.host(from)); err != nil {
			return missing(from)
		}
		if fi, err := os.Stat(g.host(to)); err == nil {
			if a["exclusive"] == true {
				return fail(17, to+": File exists")
			}
			if fi.IsDir() {
				return fail(21, to+": Is a directory")
			}
		}
		if err := os.Rename(g.host(from), g.host(to)); err != nil {
			return fail(1, err.Error())
		}
		fi, _ := os.Stat(g.host(to))
		return out(psEntryOf(fi.Name(), fi))
	case psDeleteScript:
		fi, err := os.Lstat(g.host(p))
		if err != nil {
			return missing(p)
		}
		e := psEntryOf(fi.Name(), fi)
		if fi.IsDir() && a["recursive"] != true {
			if des, _ := os.ReadDir(g.host(p)); len(des) > 0 {
				return fail(39, p+": Directory not empty")
			}
		}
		_ = os.RemoveAll(g.host(p))
		return out(e)
	}
	return nil, []byte("not one of the bridge's scripts"), 1
}

func (g *psGuest) lastParams() map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.params[len(g.params)-1]
}

func TestE2EWindows(t *testing.T) {
	g := &psGuest{root: t.TempDir()}
	e := newE2E(t, &fakeagent.Agent{Windows: true, Exec: g.exec, Path: g.host})
	mkfile(t, filepath.Join(g.root, "Users", "k4all", "notes.txt"), []byte("hello"))
	for _, n := range []string{"a", "b", "c"} {
		mkfile(t, filepath.Join(g.root, "Users", "k4all", "Desktop", n+".lnk"), nil)
	}

	var list v1alpha1.GuestFileList
	e.decode(e.do(http.MethodGet, q("op", "list", "path", "c:/Users/k4all"), nil), http.StatusOK, &list)
	if g.lastParams()["path"] != `C:\Users\k4all` {
		t.Errorf("the script got %v", g.lastParams())
	}
	if len(list.Entries) != 2 || list.Entries[0].Name != "Desktop" || list.Entries[0].Type != "directory" ||
		list.Entries[1].Name != "notes.txt" || list.Entries[1].Size != 5 || list.Entries[1].Mode != nil || list.Partial || list.Cursor != "" {
		t.Errorf("%+v", list)
	}

	// Pages of two: the second page is one object.
	var names []string
	cursor := ""
	for range 3 {
		params := q("op", "list", "path", `C:\Users\k4all\Desktop`, "limit", "2")
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		var list v1alpha1.GuestFileList
		e.decode(e.do(http.MethodGet, params, nil), http.StatusOK, &list)
		for _, f := range list.Entries {
			names = append(names, f.Name)
		}
		if cursor = list.Cursor; cursor == "" {
			break
		}
	}
	if strings.Join(names, ",") != "a.lnk,b.lnk,c.lnk" {
		t.Errorf("pages: %v", names)
	}

	var fi v1alpha1.GuestFileInfo
	e.decode(e.do(http.MethodGet, q("op", "stat", "path", `C:\Users\k4all\notes.txt`), nil), http.StatusOK, &fi)
	if fi.Name != "notes.txt" || fi.Size != 5 || fi.Type != "file" || fi.MTime == "" {
		t.Errorf("%+v", fi)
	}
	e.failure(e.do(http.MethodGet, q("op", "stat", "path", `C:\nothing`), nil), http.StatusNotFound, v1alpha1.CauseNotFound)
	e.failure(e.do(http.MethodGet, q("op", "list", "path", "/etc"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)

	// Up and down through guest-file-*, with Windows paths.
	data := bytes.Repeat([]byte("0123456789abcdef"), 160_000)
	for off := 0; off < len(data); off += v1alpha1.MaxWriteBody {
		params := q("op", "write", "path", `C:\Users\k4all\big.bin`, "offset", strconv.Itoa(off))
		if off == 0 {
			params.Set("truncate", "true")
		}
		e.decode(e.do(http.MethodPut, params, data[off:min(off+v1alpha1.MaxWriteBody, len(data))]), http.StatusOK, nil)
	}
	w := e.do(http.MethodGet, q("op", "read", "path", `C:\Users\k4all\big.bin`, "length", strconv.Itoa(len(data))), nil)
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get(v1alpha1.HeaderFileMTime) == "" {
		t.Fatalf("%d, %d bytes, %v", w.Code, w.Body.Len(), w.Header())
	}
	var h v1alpha1.GuestFileHash
	e.decode(e.do(http.MethodGet, q("op", "hash", "path", `C:\Users\k4all\big.bin`), nil), http.StatusOK, &h)
	sum := sha256.Sum256(data)
	if h.Hash != hex.EncodeToString(sum[:]) || h.Size != int64(len(data)) {
		t.Errorf("%+v", h)
	}

	e.decode(e.do(http.MethodPost, q("op", "mkdir", "path", `C:\Users\k4all\New folder`), nil), http.StatusCreated, &fi)
	e.decode(e.do(http.MethodPost, q("op", "mkdir", "path", `C:\Users\k4all\New folder`), nil), http.StatusOK, &fi)
	e.decode(e.do(http.MethodPost, q("op", "create", "path", `C:\Users\k4all\New folder\x.txt`, "exclusive", "true"), nil), http.StatusCreated, &fi)
	e.failure(e.do(http.MethodPost, q("op", "create", "path", `C:\Users\k4all\New folder\x.txt`, "exclusive", "true"), nil), http.StatusConflict, v1alpha1.CauseAlreadyExists)
	e.decode(e.do(http.MethodPost, q("op", "rename", "from", `C:\Users\k4all\New folder\x.txt`, "to", `C:\Users\k4all\y.txt`), nil), http.StatusOK, &fi)
	if fi.Name != "y.txt" {
		t.Errorf("%+v", fi)
	}
	e.failure(e.do(http.MethodPost, q("op", "chown", "path", `C:\Users\k4all\y.txt`, "owner", "k4all"), nil), http.StatusNotImplemented, v1alpha1.CauseNotSupported)
	e.failure(e.do(http.MethodDelete, q("op", "delete", "path", `C:\Users\k4all`), nil), http.StatusConflict, v1alpha1.CauseDirectoryNotEmpty)
	e.failure(e.do(http.MethodDelete, q("op", "delete", "path", `C:\`, "recursive", "true"), nil), http.StatusBadRequest, v1alpha1.CauseInvalid)
	e.decode(e.do(http.MethodDelete, q("op", "delete", "path", `C:\Users\k4all\New folder`, "recursive", "true"), nil), http.StatusOK, nil)
	if _, err := os.Stat(filepath.Join(g.root, "Users", "k4all", "New folder")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("not deleted: %v", err)
	}

	// Every program was the bridge's PowerShell: no /bin/sh, no restorecon.
	for _, c := range e.server.Calls() {
		if strings.Contains(c.Cmd, `"guest-exec"`) && !strings.Contains(c.Cmd, `"path":"powershell.exe"`) {
			t.Errorf("a program that is not PowerShell: %.200s", c.Cmd)
		}
	}
	e.clk.Step(DefaultWriteIdle)
	var reasons []string
	for _, ev := range e.rec.take() {
		reasons = append(reasons, ev.reason)
	}
	if strings.Join(reasons, ",") != "GuestDirectoryCreated,GuestFileCreated,GuestFileRenamed,GuestFileDeleted,GuestFileWritten" {
		t.Errorf("Events %v", reasons)
	}
}
