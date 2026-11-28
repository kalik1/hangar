package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestFileCommandLimits: the chunk sizes the prototype measured are the
// builders' limits: 128 KiB raw per guest-file-write (libvirt re-sends a
// larger command forever), 1 MiB per guest-file-read.
func TestFileCommandLimits(t *testing.T) {
	if _, err := FileWrite(1, make([]byte, MaxFileWrite+1)); err == nil {
		t.Error("a write over 128 KiB")
	}
	if _, err := FileWrite(1, nil); err == nil {
		t.Error("an empty write")
	}
	w, err := FileWrite(1, make([]byte, MaxFileWrite))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(w)
	// 160 KiB raw (218.5 KB of JSON) is the largest write that worked; the
	// send buffer is 212,992 bytes.
	if len(b) > 180_000 {
		t.Errorf("a 128 KiB write is %d bytes of JSON", len(b))
	}
	var back struct {
		Arguments struct {
			Handle int64  `json:"handle"`
			Buf    []byte `json:"buf-b64"`
			Count  int    `json:"count"`
		} `json:"arguments"`
	}
	if err := json.Unmarshal(b, &back); err != nil || len(back.Arguments.Buf) != MaxFileWrite || back.Arguments.Count != MaxFileWrite {
		t.Errorf("%v %d", err, len(back.Arguments.Buf))
	}

	for _, n := range []int{0, -1, MaxFileRead + 1} {
		if _, err := FileRead(1, n); err == nil {
			t.Errorf("a read of %d", n)
		}
	}
	if _, err := FileRead(1, MaxFileRead); err != nil {
		t.Error(err)
	}
	for _, p := range []string{"", "/a\x00b", "/\xff", "/" + strings.Repeat("a", MaxPath)} {
		if _, err := FileOpen(p, FileReadOnly); err == nil {
			t.Errorf("path %q", p)
		}
	}
	if _, err := FileOpen("/x", "a+"); err == nil {
		t.Error("an unknown mode")
	}
	if _, err := FileSeek(1, -1, SeekSet); err == nil {
		t.Error("a negative offset")
	}

	for _, tc := range []struct {
		cmd  Command
		want string
	}{
		{must(FileOpen(`C:\Users\a "b".txt`, FileTruncate)), `{"execute":"guest-file-open","arguments":{"path":"C:\\Users\\a \"b\".txt","mode":"w"}}`},
		{must(FileRead(7, 1<<20)), `{"execute":"guest-file-read","arguments":{"handle":7,"count":1048576}}`},
		{must(FileSeek(7, 0, SeekEnd)), `{"execute":"guest-file-seek","arguments":{"handle":7,"offset":0,"whence":"end"}}`},
		{FileClose(7), `{"execute":"guest-file-close","arguments":{"handle":7}}`},
		{ExecStatus(1234), `{"execute":"guest-exec-status","arguments":{"pid":1234}}`},
		{must(FileWrite(7, []byte("hi"))), `{"execute":"guest-file-write","arguments":{"handle":7,"buf-b64":"aGk=","count":2}}`},
	} {
		got, _ := json.Marshal(tc.cmd)
		if string(got) != tc.want {
			t.Errorf("%s\nwant %s", got, tc.want)
		}
	}
}

func must(c Command, err error) Command {
	if err != nil {
		panic(err)
	}
	return c
}

// TestExecCommands: a script is a constant; the client's values are its
// arguments, never parsed as code.
func TestExecCommands(t *testing.T) {
	sh, err := ShellScript(`echo "$1"`, `$(reboot); "x`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(sh)
	want := `{"execute":"guest-exec","arguments":{"path":"/bin/sh","arg":["-c","echo \"$1\"","sh","$(reboot); \"x"],"capture-output":true}}`
	if string(b) != want {
		t.Errorf("%s\nwant %s", b, want)
	}
	if _, err := ShellScript(`true`, "a\x00b"); err == nil {
		t.Error("a NUL in an argument")
	}
	if _, err := ShellScript(`true`, strings.Repeat("a", maxExecArgs)); err == nil {
		t.Error("arguments over the limit")
	}

	ps, err := PowerShellScript(`Write-Output $A.path`, map[string]string{"path": `C:\a'); Remove-Item C:\ -Recurse; ('`})
	if err != nil {
		t.Fatal(err)
	}
	var x struct {
		Arguments execArgs `json:"arguments"`
	}
	b, _ = json.Marshal(ps)
	if err := json.Unmarshal(b, &x); err != nil {
		t.Fatal(err)
	}
	a := x.Arguments
	if a.Path != "powershell.exe" || len(a.Arg) != 4 || a.Arg[2] != "-EncodedCommand" || !a.CaptureOutput {
		t.Fatalf("%+v", a)
	}
	text, err := DecodePowerShell(a.Arg[3])
	if err != nil {
		t.Fatal(err)
	}
	first, rest, _ := strings.Cut(text, "\n")
	if rest != `Write-Output $A.path` {
		t.Errorf("the script: %q", rest)
	}
	// The parameters are in a base64 literal: no quote of theirs reaches
	// PowerShell's parser.
	lit := strings.TrimSuffix(strings.TrimPrefix(first, "$A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"), "')) | ConvertFrom-Json")
	raw, err := base64.StdEncoding.DecodeString(lit)
	if err != nil || !strings.Contains(string(raw), `Remove-Item`) || strings.ContainsAny(lit, `'"; `) {
		t.Errorf("%q %q %v", first, raw, err)
	}
	if _, err := PowerShellScript(`x`, map[string]string{"path": strings.Repeat("é", 8000)}); err == nil {
		t.Error("a command line over Windows' limit")
	}
}

// TestExec: guest-exec, then guest-exec-status until the program exits.
func TestExec(t *testing.T) {
	f := &fakeCaller{}
	polls := 0
	f.set(func(name string) (string, error) {
		switch name {
		case CmdExec:
			return `{"return":{"pid":42}}`, nil
		case CmdExecStatus:
			polls++
			if polls < 3 {
				return `{"return":{"exited":false}}`, nil
			}
			return `{"return":{"exited":true,"exitcode":3,"out-data":"b3V0","err-data":"ZXJy"}}`, nil
		}
		return `{"return":{}}`, nil
	})
	vm := NewVM("vms_vm", f, VMConfig{})
	cmd, _ := ShellScript(`exit 3`)
	res, err := vm.Exec(context.Background(), cmd, time.Second)
	if err != nil || res.ExitCode != 3 || string(res.Stdout) != "out" || string(res.Stderr) != "err" {
		t.Fatalf("%+v %v", res, err)
	}
	if got := f.take(); len(got) != 4 {
		t.Errorf("calls %v", got)
	}

	// A program that does not end: Timeout, and the agent stays healthy.
	f.set(func(name string) (string, error) {
		if name == CmdExec {
			return `{"return":{"pid":43}}`, nil
		}
		return `{"return":{"exited":false}}`, nil
	})
	_, err = vm.Exec(context.Background(), cmd, 50*time.Millisecond)
	if ReasonOf(err) != Timeout || !vm.Health().Healthy {
		t.Errorf("%v %+v", err, vm.Health())
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if _, err := vm.Exec(ctx, cmd, time.Minute); err != context.Canceled {
		t.Errorf("canceled: %v", err)
	}
	if _, err := vm.Exec(context.Background(), Ping(), time.Second); err == nil {
		t.Error("Exec of guest-ping")
	}
}

func TestFileCalls(t *testing.T) {
	f := &fakeCaller{}
	f.set(func(name string) (string, error) {
		switch name {
		case CmdFileOpen:
			return `{"return":7}`, nil
		case CmdFileRead:
			return `{"return":{"count":2,"buf-b64":"aGk=","eof":true}}`, nil
		case CmdFileWrite:
			return `{"return":{"count":2,"eof":false}}`, nil
		case CmdFileSeek:
			return `{"return":{"position":10,"eof":false}}`, nil
		}
		return `{"return":{}}`, nil
	})
	vm := NewVM("vms_vm", f, VMConfig{})
	ctx := context.Background()
	h, err := vm.OpenFile(ctx, "/x", FileReadOnly)
	if err != nil || h != 7 {
		t.Fatal(h, err)
	}
	data, eof, err := vm.ReadFile(ctx, h, 10)
	if err != nil || string(data) != "hi" || !eof {
		t.Error(data, eof, err)
	}
	if _, _, err := vm.ReadFile(ctx, h, 1); err == nil {
		t.Error("a reply larger than the count")
	}
	if n, err := vm.WriteFile(ctx, h, []byte("hi")); err != nil || n != 2 {
		t.Error(n, err)
	}
	if _, err := vm.WriteFile(ctx, h, []byte("h")); err == nil {
		t.Error("the agent wrote more than it got")
	}
	if pos, err := vm.SeekFile(ctx, h, 0, SeekEnd); err != nil || pos != 10 {
		t.Error(pos, err)
	}
	if err := vm.CloseFile(ctx, h); err != nil {
		t.Error(err)
	}
}
