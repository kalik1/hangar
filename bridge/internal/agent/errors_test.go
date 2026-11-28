package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"syscall"
	"testing"

	libvirt "github.com/digitalocean/go-libvirt"
)

func lverr(code libvirt.ErrorNumber, msg string) error {
	return libvirt.Error{Code: uint32(code), Message: msg}
}

// TestClassify feeds libvirt's errors, as the prototype saw them from
// libvirt 11.10, and the ones its source makes.
func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want Reason
	}{
		{"blocked (Rocky's allow-list)", lverr(libvirt.ErrAgentCommandFailed,
			"guest agent command failed: unable to execute QEMU agent command 'guest-exec': Command guest-exec has been disabled: the command is not allowed"), Blocked},
		{"missing in this agent", lverr(libvirt.ErrAgentCommandFailed,
			"guest agent command failed: unable to execute QEMU agent command 'guest-get-load': The command guest-get-load has not been found"), NotSupported},
		{"the agent fails it", lverr(libvirt.ErrAgentCommandFailed,
			"guest agent command failed: unable to execute QEMU agent command 'guest-file-open': failed to open file '/root/ga-w' (mode: 'w'): Permission denied"), AgentError},
		{"an internal error of the agent", lverr(libvirt.ErrInternalError,
			"internal error: unable to execute QEMU agent command 'guest-get-fsinfo': something"), AgentError},
		{"libvirt's agent error state", lverr(libvirt.ErrAgentUnresponsive,
			"Guest agent is not responding: QEMU guest agent is not available due to an error"), NotResponding},
		{"no guest-sync answer", lverr(libvirt.ErrAgentUnresponsive,
			"Guest agent is not responding: guest agent didn't respond to synchronization within '5' seconds"), NotResponding},
		{"unsynced", lverr(libvirt.ErrAgentUnsynced, "guest agent replied with wrong id to guest-sync"), NotResponding},
		{"not connected (qemu-ga restarting)", lverr(libvirt.ErrAgentUnresponsive,
			"Guest agent is not responding: QEMU guest agent is not connected"), NotConnected},
		{"no agent channel", lverr(libvirt.ErrArgumentUnsupported, "argument unsupported: QEMU guest agent is not configured"), NotConnected},
		{"a paused VM", lverr(libvirt.ErrOperationInvalid, "Requested operation is not valid: domain is not running"), NotConnected},
		{"the command's timeout", lverr(libvirt.ErrAgentCommandTimeout, "Guest agent didn't respond to command within timeout"), Timeout},
		{"the job lock", lverr(libvirt.ErrOperationTimeout,
			"Timed out during operation: cannot acquire state change lock (held by agent=qemuDispatchDomainAgentCommand)"), Timeout},
		{"the bridge's deadline", fmt.Errorf("wait: %w", context.DeadlineExceeded), Timeout},
	} {
		err := classify("guest-x", tc.err)
		if got := ReasonOf(err); got != tc.want {
			t.Errorf("%s: %v, want %s", tc.name, err, tc.want)
		}
		var e *Error
		if errors.As(err, &e) && (e.Message == "" || e.Command != "guest-x") {
			t.Errorf("%s: %+v", tc.name, e)
		}
	}

	blocked := classify(CmdGetUsers, lverr(libvirt.ErrAgentCommandFailed, "guest agent command failed: unable to execute QEMU agent command 'guest-get-users': Command guest-get-users has been disabled: the command is not allowed"))
	if e := new(Error); !errors.As(blocked, &e) || e.Message != BlockedError(CmdGetUsers).Message {
		t.Errorf("a blocked command's message: %v", blocked)
	}

	for _, err := range []error{libvirt.ErrInterrupted, io.EOF, syscall.EINVAL, fmt.Errorf("x: %w", errBadPacket)} {
		if got := classify("guest-x", err); !errors.Is(got, ErrConnectionLost) {
			t.Errorf("%v: %v, want ErrConnectionLost", err, got)
		}
	}
	if got := classify("guest-x", lverr(libvirt.ErrNoDomain, "Domain not found")); !errors.Is(got, ErrNoDomain) {
		t.Errorf("no domain: %v", got)
	}
	if got := classify("guest-x", context.Canceled); !errors.Is(got, context.Canceled) || ReasonOf(got) != "" {
		t.Errorf("canceled: %v", got)
	}
	if classify("guest-x", nil) != nil {
		t.Error("nil is an error")
	}
}

func TestParseReply(t *testing.T) {
	ret, err := parseReply("guest-info", `{"return":{"version":"11.1.2"}}`)
	if err != nil || string(ret) != `{"version":"11.1.2"}` {
		t.Errorf("%s, %v", ret, err)
	}
	for reply, want := range map[string]Reason{
		`{"error":{"class":"CommandNotFound","desc":"Command guest-exec has been disabled: the command is not allowed"}}`: Blocked,
		`{"error":{"class":"CommandNotFound","desc":"The command guest-get-load has not been found"}}`:                    NotSupported,
		`{"error":{"class":"GenericError","desc":"Permission denied"}}`:                                                   AgentError,
		`{}`:       AgentError,
		`not json`: AgentError,
	} {
		if _, err := parseReply("guest-x", reply); ReasonOf(err) != want {
			t.Errorf("%s: %v, want %s", reply, err, want)
		}
	}
}
