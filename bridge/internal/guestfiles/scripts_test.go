package guestfiles

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// sh runs a script as guest-exec does, on this host.
func sh(t *testing.T, script string, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("/bin/sh", append([]string{"-c", script, "sh"}, args...)...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return stdout.String(), stderr.String(), code
}

// TestRunBoundsErrors: run cuts a command's error messages to 2 KiB, keeps
// its status, and lets it finish however much it writes.
func TestRunBoundsErrors(t *testing.T) {
	out, errs, code := sh(t, shPrelude+`run sh -c 'i=0; while [ $i -lt 5000 ]; do echo "error line $i" >&2; i=$((i+1)); done; echo done; exit 3'
echo "status $?"`)
	if out != "done\nstatus 3\n" || len(errs) != 2048 || code != 0 {
		t.Errorf("%q, %d bytes of errors, %d", out, len(errs), code)
	}
}

// TestListScriptBytes: a listing over its byte bound stays in a temporary
// file, whatever its count.
func TestListScriptBytes(t *testing.T) {
	dir, tmp := t.TempDir(), t.TempDir()
	for i := range 3 {
		mkfile(t, filepath.Join(dir, strings.Repeat("n", 200)+strconv.Itoa(i)), nil)
	}
	out, _, code := sh(t, listScript, dir, "5000", "100", tmp)
	header, _, _ := strings.Cut(out, "\n")
	h, err := parseListHeader(header)
	if err != nil || code != 0 || h.count != 3 || h.file == "" || h.status != 0 {
		t.Fatalf("%q: %+v %v", out, h, err)
	}
	if _, err := os.Stat(filepath.Join(tmp, h.file)); err != nil {
		t.Errorf("no temporary file: %v", err)
	}
	if _, _, code := sh(t, unlistScript, tmp, h.file); code != 0 {
		t.Errorf("unlist: %d", code)
	}
	// unlist removes nothing but a listing's file.
	mkfile(t, filepath.Join(tmp, "keep"), nil)
	for _, name := range []string{"keep", "../keep", "hangar-ls.../../k", "hangar-ls.*"} {
		if _, _, code := sh(t, unlistScript, tmp, name); code != exitRefused {
			t.Errorf("unlist %q: %d", name, code)
		}
	}
	if left, _ := os.ReadDir(tmp); len(left) != 1 {
		t.Errorf("left %v", left)
	}
}
