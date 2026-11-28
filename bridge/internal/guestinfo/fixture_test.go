package guestinfo

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
)

// fixture is a guest's agent: the replies to each command, as libvirt
// returns them, from testdata/<name>.json. A key is a command name, or
// "guest-ssh-get-authorized-keys <user>".
type fixture struct {
	Replies map[string]fixtureReply `json:"replies"`
}

// fixtureReply is a command's return, or libvirt's error for it.
type fixtureReply struct {
	Return       json.RawMessage `json:"return"`
	LibvirtError *fixtureError   `json:"libvirtError"`
}

type fixtureError struct {
	Code    uint32 `json:"code"`
	Message string `json:"message"`
}

// fixtureCaller is an agent.Caller that answers from a fixture and records
// every command.
type fixtureCaller struct {
	fx fixture

	mu    sync.Mutex
	calls []string
	// override answers a command before the fixture does, if it returns
	// true.
	override func(name string) (handled bool, reply string, err error)
}

func loadFixture(t *testing.T, name string) *fixtureCaller {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	f := &fixtureCaller{}
	if err := json.Unmarshal(b, &f.fx); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return f
}

func (f *fixtureCaller) AgentCommand(_, cmd string, _ time.Duration) (string, error) {
	var c struct {
		Execute   string `json:"execute"`
		Arguments *struct {
			Username string `json:"username"`
		} `json:"arguments"`
	}
	if err := json.Unmarshal([]byte(cmd), &c); err != nil {
		return "", err
	}
	f.mu.Lock()
	f.calls = append(f.calls, cmd)
	override := f.override
	f.mu.Unlock()
	if override != nil {
		if handled, reply, err := override(c.Execute); handled {
			return reply, err
		}
	}
	if c.Execute == "guest-ping" {
		return `{"return":{}}`, nil
	}
	key := c.Execute
	if c.Arguments != nil {
		key += " " + c.Arguments.Username
	}
	r, ok := f.fx.Replies[key]
	switch {
	case !ok:
		return "", libvirt.Error{Code: uint32(libvirt.ErrAgentCommandFailed), Message: fmt.Sprintf(
			"guest agent command failed: unable to execute QEMU agent command '%s': The command %s has not been found", c.Execute, c.Execute)}
	case r.LibvirtError != nil:
		return "", libvirt.Error{Code: r.LibvirtError.Code, Message: r.LibvirtError.Message}
	}
	return `{"return":` + string(r.Return) + `}`, nil
}

// setReply adds or replaces the reply to a fixture's key, for a test's own
// case. The recorded fixtures stay as the guests answered.
func (f *fixtureCaller) setReply(key string, r fixtureReply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fx.Replies[key] = r
}

// names returns the names of the commands called, in order.
func (f *fixtureCaller) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		var v struct {
			Execute string `json:"execute"`
		}
		_ = json.Unmarshal([]byte(c), &v)
		out = append(out, v.Execute)
	}
	return out
}

func (f *fixtureCaller) raw() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fixtureCaller) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}
