package peer

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apiserver/pkg/authentication/user"

	"github.com/kalik1/hangar/bridge/internal/certs"
)

const serverName = "hangar-guest-bridge.hangar-system.svc"

type received struct {
	method, path, query, body string
	header                    http.Header
}

// peerServer is a bridge pod on another node: a TLS server with a
// certificate of the bundle's CA, which records what it gets.
func peerServer(t *testing.T, b *certs.Bundle) (*httptest.Server, func() received) {
	t.Helper()
	var mu sync.Mutex
	var got received
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = received{r.Method, r.URL.Path, r.URL.RawQuery, string(body), r.Header.Clone()}
		mu.Unlock()
		w.Header().Set("Audit-Id", "peer-audit-id")
		w.Header().Set("X-Answer", "from the peer")
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = io.WriteString(w, "peer body")
	}))
	pair, err := tls.X509KeyPair(b.Cert, b.Key)
	if err != nil {
		t.Fatal(err)
	}
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, func() received { mu.Lock(); defer mu.Unlock(); return got }
}

func hostPort(t *testing.T, srv *httptest.Server) (string, int) {
	t.Helper()
	host, port, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	p, _ := strconv.Atoi(port)
	return host, p
}

func tokenFile(t *testing.T, token string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(p, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func generate(t *testing.T) *certs.Bundle {
	t.Helper()
	b, err := certs.Generate(time.Now(), []string{serverName})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var alice = &user.DefaultInfo{
	Name:   "alice",
	UID:    "alice-uid",
	Groups: []string{"devs", "system:authenticated"},
	Extra:  map[string][]string{"example.com/team": {"blue"}},
}

func inbound() *http.Request {
	r := httptest.NewRequest(http.MethodPut,
		"/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestfiles?op=write&path=%2Ftmp%2Fx",
		strings.NewReader("hello"))
	// What must not reach the peer: the caller's own credentials and any
	// identity or impersonation headers that came with the call.
	r.Header.Set("Authorization", "Bearer users-own-token")
	r.Header.Set("X-Remote-User", "mallory")
	r.Header.Set("X-Remote-Extra-Scopes", "admin")
	r.Header.Set("Impersonate-User", "admin")
	r.Header.Set("Impersonate-Group", "system:masters")
	r.Header.Set("Content-Type", "application/octet-stream")
	return r
}

func TestForwardCarriesTheCallerAndTheToken(t *testing.T) {
	b := generate(t)
	srv, got := peerServer(t, b)
	host, port := hostPort(t, srv)
	f := &Forwarder{Port: port, ServerName: serverName, CA: func() []byte { return b.CACert }, TokenFile: tokenFile(t, "peer-token")}

	w := httptest.NewRecorder()
	w.Header().Set("Audit-Id", "this-servers-audit-id")
	f.Forward(w, inbound(), host, "node-b", alice)

	if w.Code != http.StatusMultiStatus || w.Body.String() != "peer body" || w.Header().Get("X-Answer") != "from the peer" {
		t.Fatalf("answer %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	if ids := w.Header().Values("Audit-Id"); !slices.Equal(ids, []string{"peer-audit-id"}) {
		t.Errorf("Audit-Id %v: the peer's must replace this server's", ids)
	}
	r := got()
	if r.method != http.MethodPut || r.path != "/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestfiles" ||
		r.query != "op=write&path=%2Ftmp%2Fx" || r.body != "hello" {
		t.Errorf("request %+v", r)
	}
	h := r.header
	checks := map[string][]string{
		"Authorization":                     {"Bearer peer-token"},
		"X-Remote-User":                     {"alice"},
		"X-Remote-Uid":                      {"alice-uid"},
		"X-Remote-Group":                    {"devs", "system:authenticated"},
		"X-Remote-Extra-Example.com%2fteam": {"blue"},
		"Content-Type":                      {"application/octet-stream"},
	}
	for name, want := range checks {
		if got := h.Values(name); !slices.Equal(got, want) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	for _, name := range []string{"Impersonate-User", "Impersonate-Group", "X-Remote-Extra-Scopes"} {
		if v := h.Values(name); len(v) > 0 {
			t.Errorf("%s reached the peer: %v", name, v)
		}
	}
}

func status(t *testing.T, w *httptest.ResponseRecorder) metav1.Status {
	t.Helper()
	var s metav1.Status
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatalf("not a Status: %q", w.Body.String())
	}
	if int(s.Code) != w.Code || s.Kind != "Status" {
		t.Errorf("status %+v for code %d", s, w.Code)
	}
	return s
}

func TestForwardToAnUnreachablePeer(t *testing.T) {
	b := generate(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(l.Addr().String())
	_ = l.Close()
	p, _ := strconv.Atoi(port)
	f := &Forwarder{Port: p, ServerName: serverName, CA: func() []byte { return b.CACert }, TokenFile: tokenFile(t, "t")}
	w := httptest.NewRecorder()
	f.Forward(w, inbound(), "127.0.0.1", "node-b", alice)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code %d", w.Code)
	}
	if s := status(t, w); !strings.Contains(s.Message, "node node-b") {
		t.Errorf("message %q", s.Message)
	}
}

func TestForwardRefusesAPeerOfAnotherCA(t *testing.T) {
	b, other := generate(t), generate(t)
	srv, got := peerServer(t, other)
	host, port := hostPort(t, srv)
	f := &Forwarder{Port: port, ServerName: serverName, CA: func() []byte { return b.CACert }, TokenFile: tokenFile(t, "secret-token")}
	w := httptest.NewRecorder()
	f.Forward(w, inbound(), host, "node-b", alice)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code %d", w.Code)
	}
	if got().header != nil {
		t.Error("the token went to a server the CA does not vouch for")
	}
}

func TestForwardFollowsANewCA(t *testing.T) {
	first, second := generate(t), generate(t)
	var mu sync.Mutex
	current := first.CACert
	f := &Forwarder{ServerName: serverName, CA: func() []byte { mu.Lock(); defer mu.Unlock(); return current }, TokenFile: tokenFile(t, "t")}

	srv1, _ := peerServer(t, first)
	host, port := hostPort(t, srv1)
	f.Port = port
	w := httptest.NewRecorder()
	f.Forward(w, inbound(), host, "node-b", alice)
	if w.Code != http.StatusMultiStatus {
		t.Fatalf("first CA: code %d", w.Code)
	}

	srv2, _ := peerServer(t, second)
	host, port = hostPort(t, srv2)
	f.Port = port
	mu.Lock()
	current = second.CACert
	mu.Unlock()
	w = httptest.NewRecorder()
	f.Forward(w, inbound(), host, "node-b", alice)
	if w.Code != http.StatusMultiStatus {
		t.Fatalf("second CA: code %d", w.Code)
	}
}

func TestForwardWithoutToken(t *testing.T) {
	b := generate(t)
	f := &Forwarder{Port: 1, ServerName: serverName, CA: func() []byte { return b.CACert }, TokenFile: filepath.Join(t.TempDir(), "missing")}
	w := httptest.NewRecorder()
	f.Forward(w, inbound(), "127.0.0.1", "node-b", alice)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code %d", w.Code)
	}
	status(t, w)
}

func TestForwardWithoutCA(t *testing.T) {
	f := &Forwarder{Port: 1, ServerName: serverName, CA: func() []byte { return nil }, TokenFile: tokenFile(t, "t")}
	w := httptest.NewRecorder()
	f.Forward(w, inbound(), "127.0.0.1", "node-b", alice)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code %d", w.Code)
	}
}

func TestForwardOversizedBody(t *testing.T) {
	b := generate(t)
	srv, _ := peerServer(t, b)
	host, port := hostPort(t, srv)
	f := &Forwarder{Port: port, ServerName: serverName, CA: func() []byte { return b.CACert }, TokenFile: tokenFile(t, "t")}
	w := httptest.NewRecorder()
	r := inbound()
	// A chunked body over the cap the server put on it.
	r.Body = http.MaxBytesReader(w, io.NopCloser(strings.NewReader(strings.Repeat("x", 64<<10))), 1024)
	r.ContentLength = -1
	f.Forward(w, r, host, "node-b", alice)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code %d: %s", w.Code, w.Body.String())
	}
}
