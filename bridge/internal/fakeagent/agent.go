// Package fakeagent is a stand-in for a guest's qemu-ga, for tests: behind
// fakelibvirt, it answers guest-info, guest-get-osinfo, guest-ping, the
// guest-file-* commands on this host's files, and guest-exec, which runs the
// program on this host (the bridge's Linux scripts then run for real) or
// through a function the test gives.
package fakeagent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/kalik1/hangar/bridge/internal/fakelibvirt"
)

// Commands are the commands the fake's guest-info lists.
var Commands = []string{
	"guest-info", "guest-ping", "guest-sync", "guest-sync-delimited", "guest-get-osinfo", "guest-get-host-name",
	"guest-exec", "guest-exec-status",
	"guest-file-open", "guest-file-close", "guest-file-read", "guest-file-write", "guest-file-seek", "guest-file-flush",
}

// ExecFunc runs a guest-exec program and returns what it printed and its
// exit status.
type ExecFunc func(path string, args []string) (stdout, stderr []byte, code int)

// Agent is a fake qemu-ga.
type Agent struct {
	// Windows makes guest-get-osinfo answer mswindows.
	Windows bool
	// Disabled are commands guest-info lists as disabled, which answer as
	// a qemu-ga allow-list makes them.
	Disabled []string
	// Exec runs guest-exec's programs; nil runs them on this host.
	Exec ExecFunc
	// Path maps a guest path of guest-file-open to a path of this host;
	// nil keeps it.
	Path func(string) string
	// Hook, when set, answers a command first: it returns ok false to let
	// the fake answer.
	Hook func(name string, args json.RawMessage) (reply string, err *fakelibvirt.Error, ok bool)

	mu     sync.Mutex
	files  map[int64]*os.File
	procs  map[int64]*proc
	next   int64
	writes []int
	reads  []int
}

type proc struct {
	done   chan struct{}
	stdout []byte
	stderr []byte
	code   int
}

// Func answers agent commands, for fakelibvirt.Server.Agent.
func (a *Agent) Func() fakelibvirt.AgentFunc {
	return func(_, cmd string) (string, *fakelibvirt.Error) { return a.handle(cmd) }
}

// WriteSizes are the raw sizes of the guest-file-write calls so far.
func (a *Agent) WriteSizes() []int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]int(nil), a.writes...)
}

// ReadCounts are the counts of the guest-file-read calls so far.
func (a *Agent) ReadCounts() []int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]int(nil), a.reads...)
}

// OpenFiles is the number of open handles.
func (a *Agent) OpenFiles() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.files)
}

func ret(v any) (string, *fakelibvirt.Error) {
	b, err := json.Marshal(map[string]any{"return": v})
	if err != nil {
		return "", &fakelibvirt.Error{Code: fakelibvirt.ErrInternalError, Message: err.Error()}
	}
	return string(b), nil
}

// Failed is the libvirt error of a command the agent ran and failed.
func Failed(cmd, desc string) *fakelibvirt.Error {
	return &fakelibvirt.Error{Code: fakelibvirt.ErrAgentCommandFailed,
		Message: fmt.Sprintf("internal error: unable to execute QEMU agent command '%s': %s", cmd, desc)}
}

func (a *Agent) handle(raw string) (string, *fakelibvirt.Error) {
	var c struct {
		Execute   string          `json:"execute"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return "", Failed("", "QMP input must be a JSON object")
	}
	if a.Hook != nil {
		if reply, err, ok := a.Hook(c.Execute, c.Arguments); ok {
			return reply, err
		}
	}
	for _, d := range a.Disabled {
		if d == c.Execute {
			return "", Failed(c.Execute, fmt.Sprintf("Command %s has been disabled: the command is not allowed", c.Execute))
		}
	}
	switch c.Execute {
	case "guest-info":
		type cmd struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
		}
		var cmds []cmd
		for _, n := range Commands {
			enabled := true
			for _, d := range a.Disabled {
				enabled = enabled && d != n
			}
			cmds = append(cmds, cmd{n, enabled})
		}
		return ret(map[string]any{"version": "11.1.2", "supported_commands": cmds})
	case "guest-ping":
		return ret(map[string]any{})
	case "guest-get-osinfo":
		if a.Windows {
			return ret(map[string]any{"id": "mswindows", "name": "Microsoft Windows", "kernel-release": "26100"})
		}
		return ret(map[string]any{"id": "fedora", "name": "Fedora Linux", "kernel-release": "7.3.4"})
	case "guest-exec":
		return a.exec(c.Arguments)
	case "guest-exec-status":
		return a.execStatus(c.Arguments)
	case "guest-file-open":
		return a.open(c.Arguments)
	case "guest-file-read":
		return a.read(c.Arguments)
	case "guest-file-write":
		return a.write(c.Arguments)
	case "guest-file-seek":
		return a.seek(c.Arguments)
	case "guest-file-close":
		return a.close(c.Arguments)
	}
	return "", Failed(c.Execute, fmt.Sprintf("The command %s has not been found", c.Execute))
}

func (a *Agent) exec(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		Path    string   `json:"path"`
		Arg     []string `json:"arg"`
		Capture bool     `json:"capture-output"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-exec", err.Error())
	}
	run := a.Exec
	if run == nil {
		run = Local
	}
	p := &proc{done: make(chan struct{})}
	a.mu.Lock()
	if a.procs == nil {
		a.procs = map[int64]*proc{}
	}
	a.next++
	pid := a.next + 1000
	a.procs[pid] = p
	a.mu.Unlock()
	go func() {
		defer close(p.done)
		p.stdout, p.stderr, p.code = run(x.Path, x.Arg)
		if !x.Capture {
			p.stdout, p.stderr = nil, nil
		}
	}()
	return ret(map[string]any{"pid": pid})
}

// Local runs a program on this host: guest-exec's default.
func Local(path string, args []string) ([]byte, []byte, int) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(path, args...)
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		return stdout.Bytes(), stderr.Bytes(), exit.ExitCode()
	case err != nil:
		return nil, []byte(err.Error()), 127
	}
	return stdout.Bytes(), stderr.Bytes(), 0
}

func (a *Agent) execStatus(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		PID int64 `json:"pid"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-exec-status", err.Error())
	}
	a.mu.Lock()
	p := a.procs[x.PID]
	a.mu.Unlock()
	if p == nil {
		return "", Failed("guest-exec-status", "Invalid parameter 'pid'")
	}
	select {
	case <-p.done:
	default:
		return ret(map[string]any{"exited": false})
	}
	a.mu.Lock()
	delete(a.procs, x.PID)
	a.mu.Unlock()
	r := map[string]any{"exited": true, "exitcode": p.code}
	if len(p.stdout) > 0 {
		r["out-data"] = p.stdout
	}
	if len(p.stderr) > 0 {
		r["err-data"] = p.stderr
	}
	return ret(r)
}

func (a *Agent) open(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		Path string `json:"path"`
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-file-open", err.Error())
	}
	flags := map[string]int{"r": os.O_RDONLY, "r+": os.O_RDWR, "w": os.O_WRONLY | os.O_CREATE | os.O_TRUNC}
	fl, ok := flags[x.Mode]
	if !ok {
		return "", Failed("guest-file-open", fmt.Sprintf("invalid file open mode '%s'", x.Mode))
	}
	path := x.Path
	if a.Path != nil {
		path = a.Path(path)
	}
	f, err := os.OpenFile(path, fl|syscall.O_NONBLOCK, 0o644)
	if err != nil {
		return "", Failed("guest-file-open", fmt.Sprintf("failed to open file '%s' (mode: '%s'): %s", x.Path, x.Mode, strerror(err)))
	}
	a.mu.Lock()
	if a.files == nil {
		a.files = map[int64]*os.File{}
	}
	a.next++
	h := a.next
	a.files[h] = f
	a.mu.Unlock()
	return ret(h)
}

// strerror returns an error's errno as C's strerror words it.
func strerror(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		s := errno.Error()
		return string(bytes.ToUpper([]byte(s[:1]))) + s[1:]
	}
	return err.Error()
}

func (a *Agent) file(cmd string, h int64) (*os.File, *fakelibvirt.Error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := a.files[h]
	if f == nil {
		return nil, Failed(cmd, fmt.Sprintf("handle '%d' has not been found", h))
	}
	return f, nil
}

func (a *Agent) read(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		Handle int64 `json:"handle"`
		Count  *int  `json:"count"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-file-read", err.Error())
	}
	count := 4096
	if x.Count != nil {
		count = *x.Count
	}
	a.mu.Lock()
	a.reads = append(a.reads, count)
	a.mu.Unlock()
	if count > 48<<20 {
		return "", Failed("guest-file-read", "value too large for type 'int'")
	}
	f, ferr := a.file("guest-file-read", x.Handle)
	if ferr != nil {
		return "", ferr
	}
	buf := make([]byte, count)
	n, err := io.ReadFull(f, buf)
	eof := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
	if err != nil && !eof {
		return "", Failed("guest-file-read", "failed to read file: "+strerror(err))
	}
	return ret(map[string]any{"count": n, "buf-b64": buf[:n], "eof": eof})
}

func (a *Agent) write(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		Handle int64  `json:"handle"`
		Buf    []byte `json:"buf-b64"`
		Count  *int   `json:"count"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-file-write", err.Error())
	}
	a.mu.Lock()
	a.writes = append(a.writes, len(x.Buf))
	a.mu.Unlock()
	f, ferr := a.file("guest-file-write", x.Handle)
	if ferr != nil {
		return "", ferr
	}
	data := x.Buf
	if x.Count != nil {
		data = data[:min(*x.Count, len(data))]
	}
	n, err := f.Write(data)
	if err != nil {
		return "", Failed("guest-file-write", "failed to write to file: "+strerror(err))
	}
	return ret(map[string]any{"count": n, "eof": false})
}

func (a *Agent) seek(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		Handle int64  `json:"handle"`
		Offset int64  `json:"offset"`
		Whence string `json:"whence"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-file-seek", err.Error())
	}
	whence := map[string]int{"set": io.SeekStart, "cur": io.SeekCurrent, "end": io.SeekEnd}
	w, ok := whence[x.Whence]
	if !ok {
		return "", Failed("guest-file-seek", "invalid whence")
	}
	f, ferr := a.file("guest-file-seek", x.Handle)
	if ferr != nil {
		return "", ferr
	}
	pos, err := f.Seek(x.Offset, w)
	if err != nil {
		return "", Failed("guest-file-seek", "failed to seek file: "+strerror(err))
	}
	return ret(map[string]any{"position": pos, "eof": false})
}

func (a *Agent) close(args json.RawMessage) (string, *fakelibvirt.Error) {
	var x struct {
		Handle int64 `json:"handle"`
	}
	if err := json.Unmarshal(args, &x); err != nil {
		return "", Failed("guest-file-close", err.Error())
	}
	a.mu.Lock()
	f := a.files[x.Handle]
	delete(a.files, x.Handle)
	a.mu.Unlock()
	if f == nil {
		return "", Failed("guest-file-close", fmt.Sprintf("handle '%d' has not been found", x.Handle))
	}
	if err := f.Close(); err != nil {
		return "", Failed("guest-file-close", "failed to close handle: "+strerror(err))
	}
	return ret(map[string]any{})
}
