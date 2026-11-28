package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// The file and program calls of the guestfiles subresource: each is one or
// more Runs, so the VM's commands stay one at a time and KubeVirt's poller
// gets the agent between them.

// OpenFile opens path in the guest and returns its handle. The caller closes
// it with CloseFile, also when the call fails later: the agent keeps a
// handle until it is closed.
func (v *VM) OpenFile(ctx context.Context, path string, mode FileMode) (int64, error) {
	cmd, err := FileOpen(path, mode)
	if err != nil {
		return 0, err
	}
	ret, err := v.Run(ctx, cmd)
	if err != nil {
		return 0, err
	}
	var handle int64
	if err := json.Unmarshal(ret, &handle); err != nil {
		return 0, unexpected(CmdFileOpen, err)
	}
	return handle, nil
}

// ReadFile reads up to count bytes (at most MaxFileRead) at the handle's
// position, and reports whether it reached the end of the file.
func (v *VM) ReadFile(ctx context.Context, handle int64, count int) ([]byte, bool, error) {
	cmd, err := FileRead(handle, count)
	if err != nil {
		return nil, false, err
	}
	ret, err := v.Run(ctx, cmd)
	if err != nil {
		return nil, false, err
	}
	var r struct {
		Count int    `json:"count"`
		Buf   []byte `json:"buf-b64"`
		EOF   bool   `json:"eof"`
	}
	if err := json.Unmarshal(ret, &r); err != nil {
		return nil, false, unexpected(CmdFileRead, err)
	}
	if r.Count != len(r.Buf) || len(r.Buf) > count {
		return nil, false, unexpected(CmdFileRead, fmt.Errorf("%d bytes for a count of %d, asked %d", len(r.Buf), r.Count, count))
	}
	return r.Buf, r.EOF, nil
}

// WriteFile writes data (at most MaxFileWrite bytes) at the handle's
// position and returns how many bytes the agent wrote.
func (v *VM) WriteFile(ctx context.Context, handle int64, data []byte) (int, error) {
	cmd, err := FileWrite(handle, data)
	if err != nil {
		return 0, err
	}
	ret, err := v.Run(ctx, cmd)
	if err != nil {
		return 0, err
	}
	var r struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(ret, &r); err != nil {
		return 0, unexpected(CmdFileWrite, err)
	}
	if r.Count < 0 || r.Count > len(data) {
		return 0, unexpected(CmdFileWrite, fmt.Errorf("wrote %d of %d bytes", r.Count, len(data)))
	}
	return r.Count, nil
}

// SeekFile moves the handle's position and returns it.
func (v *VM) SeekFile(ctx context.Context, handle, offset int64, whence Whence) (int64, error) {
	cmd, err := FileSeek(handle, offset, whence)
	if err != nil {
		return 0, err
	}
	ret, err := v.Run(ctx, cmd)
	if err != nil {
		return 0, err
	}
	var r struct {
		Position int64 `json:"position"`
	}
	if err := json.Unmarshal(ret, &r); err != nil {
		return 0, unexpected(CmdFileSeek, err)
	}
	return r.Position, nil
}

// CloseFile flushes and closes the handle.
func (v *VM) CloseFile(ctx context.Context, handle int64) error {
	_, err := v.Run(ctx, FileClose(handle))
	return err
}

// ExecResult is what a program that guest-exec ran gave.
type ExecResult struct {
	// ExitCode is the program's exit status; -1 when a signal ended it.
	ExitCode int
	// Signal is the signal that ended it (Linux), or 0.
	Signal int
	Stdout []byte
	Stderr []byte
	// Truncated: the agent cut the output at its own limit (16 MiB). The
	// bridge's scripts bound what they print far below it.
	Truncated bool
}

// The polling of guest-exec-status: from 1 ms, doubling, up to 100 ms
// between polls. Each poll is a Run of a few milliseconds.
const (
	execFirstPoll = time.Millisecond
	execMaxPoll   = 100 * time.Millisecond
)

// Exec runs a program that ShellScript or PowerShellScript built, and polls
// guest-exec-status until it exits, at most for wait. When wait passes, the
// error is a Timeout and the program goes on in the guest: the agent has no
// command that stops it.
func (v *VM) Exec(ctx context.Context, cmd Command, wait time.Duration) (*ExecResult, error) {
	if cmd.Name() != CmdExec {
		return nil, fmt.Errorf("%s is not guest-exec", cmd.Name())
	}
	ret, err := v.Run(ctx, cmd)
	if err != nil {
		return nil, err
	}
	var started struct {
		PID *int64 `json:"pid"`
	}
	if err := json.Unmarshal(ret, &started); err != nil || started.PID == nil {
		return nil, unexpected(CmdExec, fmt.Errorf("no pid in %s", oneLineJSON(ret)))
	}

	deadline := time.Now().Add(wait)
	delay := execFirstPoll
	for {
		ret, err := v.Run(ctx, ExecStatus(*started.PID))
		if err != nil {
			return nil, err
		}
		var st struct {
			Exited       bool   `json:"exited"`
			ExitCode     *int   `json:"exitcode"`
			Signal       *int   `json:"signal"`
			OutData      []byte `json:"out-data"`
			ErrData      []byte `json:"err-data"`
			OutTruncated bool   `json:"out-truncated"`
			ErrTruncated bool   `json:"err-truncated"`
		}
		if err := json.Unmarshal(ret, &st); err != nil {
			return nil, unexpected(CmdExecStatus, err)
		}
		if st.Exited {
			res := &ExecResult{ExitCode: -1, Stdout: st.OutData, Stderr: st.ErrData, Truncated: st.OutTruncated || st.ErrTruncated}
			if st.ExitCode != nil {
				res.ExitCode = *st.ExitCode
			}
			if st.Signal != nil {
				res.Signal = *st.Signal
			}
			return res, nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			return nil, &Error{Command: CmdExecStatus, Reason: Timeout,
				Message: fmt.Sprintf("the program did not end within %s; it goes on in the guest", wait)}
		}
		t := time.NewTimer(min(delay, left))
		select {
		case <-ctx.Done():
			t.Stop()
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, ctx.Err()
			}
			return nil, &Error{Command: CmdExecStatus, Reason: Timeout, Err: ctx.Err(),
				Message: "the call's time was up before the program ended; it goes on in the guest"}
		case <-t.C:
		}
		delay = min(2*delay, execMaxPoll)
	}
}

func unexpected(cmd string, err error) *Error {
	return &Error{Command: cmd, Reason: AgentError, Err: err,
		Message: fmt.Sprintf("the agent's reply is not what %s returns: %v", cmd, err)}
}

func oneLineJSON(b []byte) string {
	if len(b) > 200 {
		b = b[:200]
	}
	return string(b)
}
