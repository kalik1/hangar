package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"

	libvirt "github.com/digitalocean/go-libvirt"
)

// Reason says why an agent command gave no answer.
type Reason string

// The reasons. The first five are the guestinfo API's errors[].reason (see
// v1alpha1); NotConnected is the agent block's connected: false.
const (
	// Blocked: the guest's agent configuration disables the command
	// (qemu-ga --allow-rpcs or --block-rpcs).
	Blocked Reason = "Blocked"
	// NotSupported: the agent has no such command, for its version or its
	// OS.
	NotSupported Reason = "NotSupported"
	// Timeout: the agent did not answer this command in time.
	Timeout Reason = "Timeout"
	// AgentError: the agent ran the command and it failed.
	AgentError Reason = "AgentError"
	// NotResponding: the agent does not answer, or libvirt marked it broken
	// (a reply over its 10 MiB limit does that). Restarting qemu-ga in the
	// guest fixes it.
	NotResponding Reason = "NotResponding"
	// NotConnected: no agent on the VM's channel: not installed, not
	// running, restarting, or the VM is not running.
	NotConnected Reason = "NotConnected"
)

// Error is an agent command that gave no answer.
type Error struct {
	// Command is the command's name.
	Command string
	Reason  Reason
	// Message is for people: the agent's or libvirt's words, and what to
	// do where there is something to do.
	Message string
	// Err is the error behind it, if any: libvirt's, say.
	Err error
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s: %s", e.Command, e.Reason, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

// ReasonOf returns the Reason of an *Error in err's chain, or "".
func ReasonOf(err error) Reason {
	var e *Error
	if errors.As(err, &e) {
		return e.Reason
	}
	return ""
}

// ErrConnectionLost is a call that failed because the connection to the
// launcher's libvirt broke: the launcher stopped or restarted. The pool
// drops the connection; the next call dials again.
var ErrConnectionLost = errors.New("the connection to the virtual machine's libvirt was lost")

// ErrNoDomain is a launcher whose libvirt does not run the VM's domain: it
// is starting, or the VM moved.
var ErrNoDomain = errors.New("the launcher's libvirt does not run this domain")

// NotRespondingAdvice ends every NotResponding message.
const NotRespondingAdvice = "Restarting the agent in the guest fixes it " +
	"(Linux: systemctl restart qemu-guest-agent; Windows: restart the QEMU Guest Agent service)."

// classify turns what a libvirt agent call returned into an *Error, or
// into ErrConnectionLost or ErrNoDomain.
//
// libvirt reports the agent's own errors (a qemu-ga error reply) as
// VIR_ERR_AGENT_COMMAND_FAILED, "unable to execute QEMU agent command
// 'NAME': DESC"; qemu-ga's DESC is "Command NAME has been disabled: ..." for
// a blocked command and "The command NAME has not been found" for one it
// does not have.
func classify(cmd string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{Command: cmd, Reason: Timeout, Message: "the guest agent did not answer in time", Err: err}
	}
	if isConnectionLost(err) {
		return fmt.Errorf("%w: %v", ErrConnectionLost, err)
	}

	var lerr libvirt.Error
	if !errors.As(err, &lerr) {
		return &Error{Command: cmd, Reason: AgentError, Message: err.Error(), Err: err}
	}
	msg := lerr.Message
	lower := strings.ToLower(msg)
	switch code := libvirt.ErrorNumber(lerr.Code); {
	case code == libvirt.ErrNoDomain:
		return fmt.Errorf("%w: %s", ErrNoDomain, msg)
	case strings.Contains(lower, "not available due to an error"):
		return &Error{Command: cmd, Reason: NotResponding, Message: msg, Err: err}
	case strings.Contains(lower, "agent is not connected"), strings.Contains(lower, "agent is not configured"),
		code == libvirt.ErrOperationInvalid && strings.Contains(lower, "not running"):
		return &Error{Command: cmd, Reason: NotConnected, Message: msg, Err: err}
	case code == libvirt.ErrAgentCommandTimeout, code == libvirt.ErrOperationTimeout:
		return &Error{Command: cmd, Reason: Timeout, Message: msg, Err: err}
	case code == libvirt.ErrAgentUnresponsive, code == libvirt.ErrAgentUnsynced:
		// The agent did not answer libvirt's guest-sync: it is not there
		// or it hangs.
		return &Error{Command: cmd, Reason: NotResponding, Message: msg, Err: err}
	}
	return agentReplyError(cmd, "", msg, err)
}

// agentReplyError classifies an error of the agent itself, from libvirt's
// message or from an error reply's class and description.
func agentReplyError(cmd, class, desc string, err error) *Error {
	lower := strings.ToLower(desc)
	switch {
	case strings.Contains(lower, "has been disabled"):
		return &Error{Command: cmd, Reason: Blocked, Message: blockedMessage(cmd), Err: err}
	case strings.Contains(lower, "has not been found"), class == "CommandNotFound":
		return &Error{Command: cmd, Reason: NotSupported, Message: fmt.Sprintf("the guest agent does not have %s: %s", cmd, desc), Err: err}
	}
	return &Error{Command: cmd, Reason: AgentError, Message: desc, Err: err}
}

func blockedMessage(cmd string) string {
	return fmt.Sprintf("the guest agent's configuration disables %s (qemu-ga --allow-rpcs or --block-rpcs; "+
		"on RHEL-family guests, FILTER_RPC_ARGS in /etc/sysconfig/qemu-ga)", cmd)
}

// BlockedError is the error of a command that guest-info lists as
// disabled: the bridge reports it without calling it.
func BlockedError(cmd string) *Error {
	return &Error{Command: cmd, Reason: Blocked, Message: blockedMessage(cmd)}
}

func isConnectionLost(err error) bool {
	if errors.Is(err, libvirt.ErrInterrupted) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, net.ErrClosed) || errors.Is(err, errBadPacket) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

// parseReply returns the "return" of an agent reply, or its "error" as an
// *Error. libvirt checks the agent's error replies itself, so this is a
// second line.
func parseReply(cmd, reply string) (json.RawMessage, error) {
	var env struct {
		Return json.RawMessage `json:"return"`
		Error  *struct {
			Class string `json:"class"`
			Desc  string `json:"desc"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(reply), &env); err != nil {
		return nil, &Error{Command: cmd, Reason: AgentError, Message: fmt.Sprintf("the agent's reply is not JSON: %v", err), Err: err}
	}
	if env.Error != nil {
		return nil, agentReplyError(cmd, env.Error.Class, env.Error.Desc, nil)
	}
	if env.Return == nil {
		return nil, &Error{Command: cmd, Reason: AgentError, Message: "the agent's reply has no return value"}
	}
	return env.Return, nil
}
