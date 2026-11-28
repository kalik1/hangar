package guestinfo

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
	"k8s.io/apimachinery/pkg/types"
	clocktesting "k8s.io/utils/clock/testing"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/fakelibvirt"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/launcher"
)

const e2ePod = types.UID("3f1c2a7e-8b5d-4c1e-9a0f-1b2c3d4e5f60")

type e2e struct {
	t      *testing.T
	server *fakelibvirt.Server
	pool   *agent.Pool
	h      *Handler
	clk    *clocktesting.FakeClock
}

// newE2E serves a fixture's agent from a fake virtqemud in a launcher's
// runtime directory under a kubelet pods directory, and a Handler that
// reaches it as the bridge does: launcher.Dialer, agent.Pool, go-libvirt.
func newE2E(t *testing.T, fixture string) *e2e {
	t.Helper()
	pods := t.TempDir()
	dir, err := fakelibvirt.MkRuntimeDir(pods, string(e2ePod), launcher.RuntimeDir)
	if err != nil {
		t.Fatal(err)
	}
	caller := loadFixture(t, fixture)
	s := &fakelibvirt.Server{Domains: []string{"vms_vm"}, Agent: fixtureAgent(caller)}
	if err := s.Listen(dir, launcher.SocketName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	d := &launcher.Dialer{PodsDir: pods}
	pool := agent.NewPool(agent.PoolConfig{Dial: d.Dial})
	t.Cleanup(pool.Close)
	clk := clocktesting.NewFakeClock(t0)
	return &e2e{t: t, server: s, pool: pool, clk: clk, h: &Handler{VMs: pool, Clock: clk}}
}

func fixtureAgent(c *fixtureCaller) fakelibvirt.AgentFunc {
	return func(domain, cmd string) (string, *fakelibvirt.Error) {
		reply, err := c.AgentCommand(domain, cmd, 0)
		var lerr libvirt.Error
		switch {
		case errors.As(err, &lerr):
			return "", &fakelibvirt.Error{Code: lerr.Code, Message: lerr.Message}
		case err != nil:
			return "", &fakelibvirt.Error{Code: fakelibvirt.ErrInternalError, Message: err.Error()}
		}
		return reply, nil
	}
}

func (e *e2e) get(query string) (int, []byte) {
	e.t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestinfo?"+query, nil)
	w := httptest.NewRecorder()
	e.h.ServeGuest(w, r, guest.Call{
		Target:      guest.Target{Namespace: "vms", Name: "vm", Phase: "Running", Node: "node-a", Pods: []types.UID{e2ePod}},
		Subresource: "guestinfo",
		Verb:        "get",
	})
	return w.Code, w.Body.Bytes()
}

func (e *e2e) commands() []string {
	var out []string
	for _, c := range e.server.Calls() {
		var v struct {
			Execute string `json:"execute"`
		}
		_ = json.Unmarshal([]byte(c.Cmd), &v)
		out = append(out, v.Execute)
	}
	return out
}

// TestE2E: the answer over a real socket and the go-libvirt client is the
// same as from the fixture directly.
func TestE2E(t *testing.T) {
	for _, fixture := range []string{"fedora", "rocky-blocked", "windows"} {
		t.Run(fixture, func(t *testing.T) {
			e := newE2E(t, fixture)
			code, body := e.get("")
			if code != http.StatusOK {
				t.Fatalf("%d %s", code, body)
			}
			var got bytes.Buffer
			if err := json.Indent(&got, body, "", "  "); err != nil {
				t.Fatal(err)
			}
			got.WriteByte('\n')
			want, err := os.ReadFile(filepath.Join("testdata", fixture+".golden.json"))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.Bytes(), want) {
				t.Errorf("the answer over the socket differs from %s.golden.json:\n%s", fixture, got.Bytes())
			}
			for _, c := range e.server.Calls() {
				if c.Domain != "vms_vm" || c.Timeout != 5 {
					t.Errorf("call %+v", c)
				}
			}
			if n := e.server.Accepted(); n != 1 {
				t.Errorf("%d connections", n)
			}
		})
	}
}

func TestE2ENotResponding(t *testing.T) {
	e := newE2E(t, "fedora")
	e.server.SetAgent(func(string, string) (string, *fakelibvirt.Error) {
		return "", &fakelibvirt.Error{Code: fakelibvirt.ErrAgentUnresponsive,
			Message: "Guest agent is not responding: QEMU guest agent is not available due to an error"}
	})
	code, body := e.get("sections=system,time")
	var info struct {
		Agent struct {
			Connected, Healthy bool
		}
		Errors []struct{ Section, Reason string }
	}
	if err := json.Unmarshal(body, &info); err != nil || code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	if !info.Agent.Connected || info.Agent.Healthy || len(info.Errors) != 2 || info.Errors[0].Reason != "NotResponding" {
		t.Errorf("%s", body)
	}
	if got := e.commands(); !slices.Equal(got, []string{agent.CmdInfo}) {
		t.Errorf("called %v", got)
	}

	// Within 30 s: an answer, and nothing reaches the agent.
	if code, body := e.get(""); code != http.StatusOK {
		t.Errorf("%d %s", code, body)
	}
	if got := e.commands(); len(got) != 1 {
		t.Errorf("called %v while not responding", got)
	}
}

func TestE2ELauncherGone(t *testing.T) {
	e := newE2E(t, "fedora")
	if code, body := e.get("sections=system"); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	e.server.Close()
	eventuallyTrue(t, func() bool { return e.pool.Len() == 0 })
	if code, body := e.get("sections=system"); code != http.StatusServiceUnavailable {
		t.Errorf("%d %s", code, body)
	}
}

func eventuallyTrue(t *testing.T, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatal("timed out")
}
