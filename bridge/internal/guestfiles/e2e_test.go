package guestfiles

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apiserver/pkg/authentication/user"
	clocktesting "k8s.io/utils/clock/testing"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/fakeagent"
	"github.com/kalik1/hangar/bridge/internal/fakelibvirt"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/launcher"
)

const e2ePod = types.UID("6a1f0c3e-2b4d-4e8f-9a1b-0c2d3e4f5a6b")

var t0 = time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)

// memRecorder keeps the Events.
type memRecorder struct {
	mu     sync.Mutex
	events []recorded
}

type recorded struct{ reason, message string }

func (m *memRecorder) Record(_ guest.Target, reason, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, recorded{reason, message})
}

func (m *memRecorder) take() []recorded {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.events
	m.events = nil
	return out
}

type e2e struct {
	t      *testing.T
	agent  *fakeagent.Agent
	server *fakelibvirt.Server
	h      *Handler
	rec    *memRecorder
	clk    *clocktesting.FakeClock
	// tmp is the guest's /var/tmp for listings.
	tmp string
}

// newE2E serves a fake agent from a fake virtqemud in a launcher's runtime
// directory, and a Handler that reaches it as the bridge does:
// launcher.Dialer, agent.Pool, go-libvirt. The agent runs the bridge's
// Linux scripts on this host.
func newE2E(t *testing.T, a *fakeagent.Agent) *e2e {
	t.Helper()
	pods := t.TempDir()
	dir, err := fakelibvirt.MkRuntimeDir(pods, string(e2ePod), launcher.RuntimeDir)
	if err != nil {
		t.Fatal(err)
	}
	s := &fakelibvirt.Server{Domains: []string{"vms_vm"}, Agent: a.Func()}
	if err := s.Listen(dir, launcher.SocketName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	d := &launcher.Dialer{PodsDir: pods}
	pool := agent.NewPool(agent.PoolConfig{Dial: d.Dial})
	t.Cleanup(pool.Close)
	clk := clocktesting.NewFakeClock(t0)
	rec := &memRecorder{}
	tmp := t.TempDir()
	h := &Handler{VMs: pool, Events: rec, Clock: clk, TempDir: tmp}
	return &e2e{t: t, agent: a, server: s, h: h, rec: rec, clk: clk, tmp: tmp}
}

var methodVerbs = map[string]string{http.MethodGet: "get", http.MethodPost: "create", http.MethodPut: "update", http.MethodDelete: "delete"}

// do calls the subresource as the dispatcher does, with the verb of the
// method, and returns the answer.
func (e *e2e) do(method string, params url.Values, body []byte) *httptest.ResponseRecorder {
	e.t.Helper()
	var r *http.Request
	u := "/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestfiles?" + params.Encode()
	if body != nil {
		r = httptest.NewRequest(method, u, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, u, nil)
	}
	w := httptest.NewRecorder()
	e.h.ServeGuest(w, r, guest.Call{
		Target:      guest.Target{Namespace: "vms", Name: "vm", UID: "vmi-uid", Phase: "Running", Node: "node-a", Pods: []types.UID{e2ePod}},
		Subresource: "guestfiles",
		Verb:        methodVerbs[method],
		User:        &user.DefaultInfo{Name: "alice"},
	})
	return w
}

func q(kv ...string) url.Values {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return v
}

// decode reads a JSON answer into out, failing unless the code is want.
func (e *e2e) decode(w *httptest.ResponseRecorder, want int, out any) {
	e.t.Helper()
	if w.Code != want {
		e.t.Fatalf("status %d, want %d: %s", w.Code, want, w.Body.String())
	}
	if out != nil {
		if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
			e.t.Fatalf("%v: %s", err, w.Body.String())
		}
	}
}

// status is the part of an error answer the Files tab reads.
type status struct {
	Code    int    `json:"code"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
	Details struct {
		Causes []struct {
			Reason, Message, Field string
		} `json:"causes"`
	} `json:"details"`
}

func (s status) cause() string {
	if len(s.Details.Causes) == 0 {
		return ""
	}
	return s.Details.Causes[0].Reason
}

// failure checks an error answer's code and cause.
func (e *e2e) failure(w *httptest.ResponseRecorder, code int, cause string) status {
	e.t.Helper()
	var st status
	e.decode(w, code, &st)
	if st.cause() != cause {
		e.t.Fatalf("cause %q, want %q: %s", st.cause(), cause, w.Body.String())
	}
	return st
}

// commands are the agent commands sent so far.
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

func readAll(t *testing.T, r io.Reader) []byte {
	t.Helper()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s || strings.HasPrefix(x, s) {
			return true
		}
	}
	return false
}
