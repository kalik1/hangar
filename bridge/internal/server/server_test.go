package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	apidiscoveryv2 "k8s.io/api/apidiscovery/v2"
	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/apiserver/pkg/server/dynamiccertificates"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/certs"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/peer"
)

const (
	serviceName = "hangar-guest-bridge.hangar-system.svc"
	basePath    = "/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/"
	bridgeToken = "bridge-token"
	otherToken  = "user-token"
	bridgeUser  = "system:serviceaccount:hangar-system:hangar-guest-bridge"
)

// --- certificates -----------------------------------------------------------

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newCA(t *testing.T, name string) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &testCA{cert: cert, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (ca *testCA) clientCert(t *testing.T, cn string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, key.Public(), ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// --- fakes ------------------------------------------------------------------

type staticFrontProxy struct {
	dynamiccertificates.CAContentProvider
	allowed []string
}

func (s *staticFrontProxy) UsernameHeaders() []string     { return []string{"X-Remote-User"} }
func (s *staticFrontProxy) UIDHeaders() []string          { return []string{"X-Remote-Uid"} }
func (s *staticFrontProxy) GroupHeaders() []string        { return []string{"X-Remote-Group"} }
func (s *staticFrontProxy) ExtraHeaderPrefixes() []string { return []string{"X-Remote-Extra-"} }
func (s *staticFrontProxy) AllowedClientNames() []string  { return s.allowed }

// unloadedCA is a front-proxy CA that has not been read yet.
type unloadedCA struct{}

func (unloadedCA) Name() string                              { return "unloaded" }
func (unloadedCA) CurrentCABundleContent() []byte            { return nil }
func (unloadedCA) VerifyOptions() (x509.VerifyOptions, bool) { return x509.VerifyOptions{}, false }
func (unloadedCA) AddListener(dynamiccertificates.Listener)  {}

type fakeLocator map[string]guest.Target

func (f fakeLocator) Locate(_ context.Context, ns, name string) (guest.Target, error) {
	t, ok := f[name]
	if !ok || ns != "vms" {
		return guest.Target{}, apierrors.NewNotFound(schemaVMI, name)
	}
	return t, nil
}

var schemaVMI = schema.GroupResource{Group: "kubevirt.io", Resource: "virtualmachineinstances"}

type fakeDirectory map[string]string

func (f fakeDirectory) Lookup(node string) (string, error) {
	ip, ok := f[node]
	if !ok {
		return "", apierrors.NewServiceUnavailable("no guest bridge is ready on node " + node)
	}
	return ip, nil
}

type forwardCall struct {
	host, node, user string
}

type fakeForwarder struct {
	mu    sync.Mutex
	calls []forwardCall
}

func (f *fakeForwarder) Forward(w http.ResponseWriter, _ *http.Request, host, node string, caller user.Info) {
	f.mu.Lock()
	f.calls = append(f.calls, forwardCall{host, node, caller.GetName()})
	f.mu.Unlock()
	guest.WriteObject(w, http.StatusOK, map[string]string{"forwardedTo": host})
}

func (f *fakeForwarder) last() (forwardCall, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return forwardCall{}, 0
	}
	return f.calls[len(f.calls)-1], len(f.calls)
}

type echo struct {
	Node        string   `json:"node"`
	Target      string   `json:"target"`
	Subresource string   `json:"subresource"`
	Verb        string   `json:"verb"`
	User        string   `json:"user"`
	Groups      []string `json:"groups"`
	Forwarded   bool     `json:"forwarded"`
	BodyBytes   int      `json:"bodyBytes"`
	BodyError   string   `json:"bodyError,omitempty"`
}

func echoHandler(w http.ResponseWriter, r *http.Request, c guest.Call) {
	body, err := io.ReadAll(r.Body)
	e := echo{
		Node: c.Target.Node, Target: c.Target.String(), Subresource: c.Subresource, Verb: c.Verb,
		User: c.User.GetName(), Groups: c.User.GetGroups(), Forwarded: peer.IsForwarded(c.User), BodyBytes: len(body),
	}
	if err != nil {
		e.BodyError = err.Error()
	}
	guest.WriteObject(w, http.StatusOK, e)
}

// fakeSAR answers SubjectAccessReviews like RBAC with a few rules, and
// records them.
type fakeSAR struct {
	mu      sync.Mutex
	reviews []authorizationv1.SubjectAccessReviewSpec
}

func (f *fakeSAR) review(sar *authorizationv1.SubjectAccessReview) {
	f.mu.Lock()
	f.reviews = append(f.reviews, sar.Spec)
	f.mu.Unlock()
	s := sar.Spec
	allowed := false
	switch {
	case s.NonResourceAttributes != nil:
		allowed = strings.HasPrefix(s.NonResourceAttributes.Path, "/apis") && slices.Contains(s.Groups, "system:authenticated")
	case s.ResourceAttributes != nil:
		ra := s.ResourceAttributes
		ok := ra.Group == v1alpha1.GroupName && ra.Resource == v1alpha1.Resource && ra.Namespace == "vms"
		switch s.User {
		case "alice": // hangar-viewer on one VM
			allowed = ok && ra.Subresource == "guestinfo" && ra.Verb == "get" && ra.Name == "vm-local"
		case "bob": // hangar-guest-admin
			allowed = ok && ra.Subresource == "guestfiles"
		case "root":
			allowed = ok
		}
	}
	sar.Status.Allowed = allowed
}

func (f *fakeSAR) lastResource() *authorizationv1.ResourceAttributes {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.reviews) - 1; i >= 0; i-- {
		if f.reviews[i].ResourceAttributes != nil {
			return f.reviews[i].ResourceAttributes
		}
	}
	return nil
}

func tokenReview(tr *authenticationv1.TokenReview) {
	switch tr.Spec.Token {
	case bridgeToken:
		tr.Status = authenticationv1.TokenReviewStatus{Authenticated: true, Audiences: []string{peer.Audience},
			User: authenticationv1.UserInfo{Username: bridgeUser}}
	case otherToken:
		tr.Status = authenticationv1.TokenReviewStatus{Authenticated: true, Audiences: []string{peer.Audience},
			User: authenticationv1.UserInfo{Username: "alice"}}
	}
}

// fakeAPIServer answers the bridge's SubjectAccessReviews and TokenReviews.
func fakeAPIServer(t *testing.T, sar *fakeSAR) kubernetes.Interface {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /apis/authorization.k8s.io/v1/subjectaccessreviews", func(w http.ResponseWriter, r *http.Request) {
		var review authorizationv1.SubjectAccessReview
		if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sar.review(&review)
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SubjectAccessReview"
		guest.WriteObject(w, http.StatusCreated, &review)
	})
	mux.HandleFunc("POST /apis/authentication.k8s.io/v1/tokenreviews", func(w http.ResponseWriter, r *http.Request) {
		var review authenticationv1.TokenReview
		if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		tokenReview(&review)
		review.APIVersion, review.Kind = "authentication.k8s.io/v1", "TokenReview"
		guest.WriteObject(w, http.StatusCreated, &review)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, ContentConfig: rest.ContentConfig{ContentType: "application/json"}})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// --- the server under test ---------------------------------------------------

type testServer struct {
	url       string
	fpCA      *testCA
	servingCA []byte
	forwarder *fakeForwarder
	sar       *fakeSAR
}

func startServer(t *testing.T, fp FrontProxy, fpCA *testCA) *testServer {
	t.Helper()
	bundle, err := certs.Generate(time.Now(), []string{serviceName})
	if err != nil {
		t.Fatal(err)
	}
	serving, err := dynamiccertificates.NewStaticCertKeyContent("serving", bundle.Cert, bundle.Key)
	if err != nil {
		t.Fatal(err)
	}
	sar := &fakeSAR{}
	client := fakeAPIServer(t, sar)
	authz, err := NewAuthorizer(client.AuthorizationV1())
	if err != nil {
		t.Fatal(err)
	}
	peerAuth, err := peer.NewAuthenticator(peer.AuthenticatorConfig{
		TokenReviews: client.AuthenticationV1().TokenReviews(), Namespace: "hangar-system", ServiceAccount: "hangar-guest-bridge",
	})
	if err != nil {
		t.Fatal(err)
	}
	fwd := &fakeForwarder{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{
		Listener:    ln,
		ServingCert: serving,
		FrontProxy:  fp,
		Peer:        peerAuth,
		Authorizer:  authz,
		Dispatcher: &Dispatcher{
			NodeName: "node-a",
			Locator: fakeLocator{
				"vm-local":  {Namespace: "vms", Name: "vm-local", Node: "node-a", Pods: []types.UID{"p1"}},
				"vm-remote": {Namespace: "vms", Name: "vm-remote", Node: "node-b", Pods: []types.UID{"p2"}},
				"vm-nopeer": {Namespace: "vms", Name: "vm-nopeer", Node: "node-z"},
			},
			Peers:    fakeDirectory{"node-b": "192.0.2.2"},
			Forward:  fwd,
			Handlers: map[string]guest.Handler{"guestinfo": guest.HandlerFunc(echoHandler), "guestfiles": guest.HandlerFunc(echoHandler)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := s.PrepareRun().RunWithContext(ctx); err != nil {
			t.Errorf("server: %v", err)
		}
	}()
	t.Cleanup(func() { cancel(); <-done })
	ts := &testServer{url: "https://" + ln.Addr().String(), fpCA: fpCA, servingCA: bundle.CACert, forwarder: fwd, sar: sar}
	ts.waitServing(t)
	return ts
}

func (ts *testServer) client(certs ...tls.Certificate) *http.Client {
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ts.servingCA)
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			RootCAs: pool, ServerName: serviceName, Certificates: certs, MinVersion: tls.VersionTLS12,
		}},
	}
}

func (ts *testServer) waitServing(t *testing.T) {
	t.Helper()
	c := ts.client()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := c.Get(ts.url + "/livez")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the server did not start")
}

type call struct {
	method, path string
	body         io.Reader
	header       map[string][]string
}

func (ts *testServer) do(t *testing.T, c *http.Client, k call) (int, []byte, http.Header) {
	t.Helper()
	req, err := http.NewRequest(k.method, ts.url+k.path, k.body)
	if err != nil {
		t.Fatal(err)
	}
	for name, vs := range k.header {
		for _, v := range vs {
			req.Header.Add(name, v)
		}
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body, resp.Header
}

// asUser is what the API server's front proxy adds.
func asUser(name string, groups ...string) map[string][]string {
	return map[string][]string{"X-Remote-User": {name}, "X-Remote-Group": append([]string{"system:authenticated"}, groups...)}
}

func withPeerToken(token, name string) map[string][]string {
	h := asUser(name)
	h["Authorization"] = []string{"Bearer " + token}
	return h
}

func newFrontProxy(t *testing.T) (*staticFrontProxy, *testCA) {
	t.Helper()
	ca := newCA(t, "front-proxy-ca")
	content, err := dynamiccertificates.NewStaticCAContent("front-proxy-ca", ca.pem)
	if err != nil {
		t.Fatal(err)
	}
	return &staticFrontProxy{CAContentProvider: content, allowed: []string{"front-proxy-client"}}, ca
}

// --- tests -------------------------------------------------------------------

func TestFrontProxyAuthentication(t *testing.T) {
	fp, fpCA := newFrontProxy(t)
	ts := startServer(t, fp, fpCA)
	clusterCA := newCA(t, "kubernetes-ca")
	get := call{method: http.MethodGet, path: basePath + "vm-local/guestinfo", header: asUser("alice")}

	cases := []struct {
		name   string
		client *http.Client
		header map[string][]string
		want   int
	}{
		{"the API server's proxy", ts.client(fpCA.clientCert(t, "front-proxy-client")), get.header, http.StatusOK},
		{"direct, no certificate", ts.client(), get.header, http.StatusUnauthorized},
		{"direct, a cluster client certificate", ts.client(clusterCA.clientCert(t, "front-proxy-client")), get.header, http.StatusUnauthorized},
		{"front-proxy CA, a name not allowed", ts.client(fpCA.clientCert(t, "someone")), get.header, http.StatusUnauthorized},
		{"direct, a user's bearer token", ts.client(), withPeerToken(otherToken, "root"), http.StatusUnauthorized},
		{"direct, a forged bearer token", ts.client(), withPeerToken("forged", "root"), http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, body, _ := ts.do(t, tc.client, call{method: get.method, path: get.path, header: tc.header})
			if code != tc.want {
				t.Fatalf("code %d, want %d: %s", code, tc.want, body)
			}
			if code == http.StatusOK {
				var e echo
				if err := json.Unmarshal(body, &e); err != nil {
					t.Fatal(err)
				}
				if e.User != "alice" || e.Verb != "get" || e.Subresource != "guestinfo" || e.Target != "vms/vm-local" || e.Forwarded {
					t.Errorf("echo %+v", e)
				}
			}
		})
	}
}

func TestAuthorizationAndVerbs(t *testing.T) {
	fp, fpCA := newFrontProxy(t)
	ts := startServer(t, fp, fpCA)
	c := ts.client(fpCA.clientCert(t, "front-proxy-client"))

	cases := []struct {
		name, method, path, user string
		want                     int
		verb                     string
	}{
		{"viewer reads guestinfo of its VM", http.MethodGet, "vm-local/guestinfo", "alice", http.StatusOK, "get"},
		// The bridge's own SubjectAccessReview refuses what RBAC does not
		// allow, even when the API server let the call through.
		{"viewer, another VM", http.MethodGet, "vm-other/guestinfo", "alice", http.StatusForbidden, ""},
		{"viewer, guestfiles", http.MethodGet, "vm-local/guestfiles", "alice", http.StatusForbidden, ""},
		{"guest admin: get", http.MethodGet, "vm-local/guestfiles?op=list&path=%2F", "bob", http.StatusOK, "get"},
		{"guest admin: create", http.MethodPost, "vm-local/guestfiles?op=mkdir&path=%2Ftmp%2Fd", "bob", http.StatusOK, "create"},
		{"guest admin: update", http.MethodPut, "vm-local/guestfiles?op=write&path=%2Ftmp%2Fx", "bob", http.StatusOK, "update"},
		{"guest admin: delete", http.MethodDelete, "vm-local/guestfiles?op=delete&path=%2Ftmp%2Fx", "bob", http.StatusOK, "delete"},
		{"guestinfo takes only get", http.MethodPut, "vm-local/guestinfo", "root", http.StatusMethodNotAllowed, ""},
		{"no patch on guestfiles", http.MethodPatch, "vm-local/guestfiles", "root", http.StatusMethodNotAllowed, ""},
		{"unknown subresource", http.MethodGet, "vm-local/console", "root", http.StatusNotFound, ""},
		{"a path below the subresource", http.MethodGet, "vm-local/guestinfo/more", "root", http.StatusNotFound, ""},
		{"a missing VMI", http.MethodGet, "vm-missing/guestinfo", "root", http.StatusNotFound, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.method == http.MethodPut || tc.method == http.MethodPost {
				body = strings.NewReader("payload")
			}
			code, out, _ := ts.do(t, c, call{method: tc.method, path: basePath + tc.path, body: body, header: asUser(tc.user)})
			if code != tc.want {
				t.Fatalf("code %d, want %d: %s", code, tc.want, out)
			}
			if code != http.StatusOK {
				var s metav1.Status
				if err := json.Unmarshal(out, &s); err != nil || s.Kind != "Status" || int(s.Code) != code {
					t.Errorf("not a Status: %s", out)
				}
				return
			}
			var e echo
			if err := json.Unmarshal(out, &e); err != nil {
				t.Fatal(err)
			}
			if e.Verb != tc.verb || e.User != tc.user {
				t.Errorf("echo %+v", e)
			}
			if body != nil && e.BodyBytes != len("payload") {
				t.Errorf("body %d bytes", e.BodyBytes)
			}
		})
	}

	// The review the bridge asked for carries the call's attributes.
	if code, out, _ := ts.do(t, c, call{method: http.MethodDelete, path: basePath + "vm-local/guestfiles?op=delete", header: asUser("bob", "admins")}); code != http.StatusOK {
		t.Fatalf("%d %s", code, out)
	}
	ra := ts.sar.lastResource()
	want := authorizationv1.ResourceAttributes{Namespace: "vms", Verb: "delete", Group: v1alpha1.GroupName, Version: v1alpha1.Version,
		Resource: v1alpha1.Resource, Subresource: "guestfiles", Name: "vm-local"}
	if ra == nil || *ra != want {
		t.Errorf("SubjectAccessReview %+v, want %+v", ra, want)
	}
}

func TestBodyLimit(t *testing.T) {
	fp, fpCA := newFrontProxy(t)
	ts := startServer(t, fp, fpCA)
	c := ts.client(fpCA.clientCert(t, "front-proxy-client"))
	path := basePath + "vm-local/guestfiles?op=write&path=%2Ftmp%2Fx"

	code, out, _ := ts.do(t, c, call{method: http.MethodPut, path: path, body: strings.NewReader(strings.Repeat("x", guest.MaxBodyBytes)), header: asUser("bob")})
	if code != http.StatusOK {
		t.Fatalf("a body of exactly the limit: %d %s", code, out)
	}
	code, out, _ = ts.do(t, c, call{method: http.MethodPut, path: path, body: strings.NewReader(strings.Repeat("x", guest.MaxBodyBytes+1)), header: asUser("bob")})
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("a body over the limit: %d %s", code, out)
	}
	// Without a Content-Length, the handler's read fails at the limit.
	code, out, _ = ts.do(t, c, call{method: http.MethodPut, path: path, body: io.MultiReader(strings.NewReader(strings.Repeat("x", guest.MaxBodyBytes+1))), header: asUser("bob")})
	var e echo
	_ = json.Unmarshal(out, &e)
	if code != http.StatusOK || e.BodyError == "" || e.BodyBytes > guest.MaxBodyBytes {
		t.Fatalf("a chunked body over the limit: %d %s", code, out)
	}
}

func TestPeerForwarding(t *testing.T) {
	fp, fpCA := newFrontProxy(t)
	ts := startServer(t, fp, fpCA)
	viaAPIServer := ts.client(fpCA.clientCert(t, "front-proxy-client"))
	direct := ts.client()

	// A call for a VMI on another node goes to that node's bridge pod.
	code, out, _ := ts.do(t, viaAPIServer, call{method: http.MethodGet, path: basePath + "vm-remote/guestinfo", header: asUser("root")})
	if code != http.StatusOK || !strings.Contains(string(out), "192.0.2.2") {
		t.Fatalf("%d %s", code, out)
	}
	if fc, n := ts.forwarder.last(); n != 1 || fc != (forwardCall{"192.0.2.2", "node-b", "root"}) {
		t.Errorf("forwarded %d times, last %+v", n, fc)
	}

	// No bridge pod on the VMI's node.
	code, out, _ = ts.do(t, viaAPIServer, call{method: http.MethodGet, path: basePath + "vm-nopeer/guestinfo", header: asUser("root")})
	if code != http.StatusServiceUnavailable {
		t.Fatalf("no peer: %d %s", code, out)
	}

	// A peer's call with the bridge's token, for a VMI on this node: served
	// here, as the caller the peer names.
	code, out, _ = ts.do(t, direct, call{method: http.MethodGet, path: basePath + "vm-local/guestinfo", header: withPeerToken(bridgeToken, "alice")})
	if code != http.StatusOK {
		t.Fatalf("peer call: %d %s", code, out)
	}
	var e echo
	if err := json.Unmarshal(out, &e); err != nil {
		t.Fatal(err)
	}
	if e.User != "alice" || !e.Forwarded || e.Node != "node-a" {
		t.Errorf("echo %+v", e)
	}

	// The bridge authorizes the forwarded caller itself.
	code, out, _ = ts.do(t, direct, call{method: http.MethodGet, path: basePath + "vm-local/guestfiles", header: withPeerToken(bridgeToken, "alice")})
	if code != http.StatusForbidden {
		t.Fatalf("peer call the caller may not make: %d %s", code, out)
	}

	// A forwarded call is never forwarded again.
	_, before := ts.forwarder.last()
	code, out, hdr := ts.do(t, direct, call{method: http.MethodGet, path: basePath + "vm-remote/guestinfo", header: withPeerToken(bridgeToken, "root")})
	if code != http.StatusServiceUnavailable || hdr.Get("Retry-After") == "" {
		t.Fatalf("forwarded call for another node: %d %s", code, out)
	}
	if _, after := ts.forwarder.last(); after != before {
		t.Error("a forwarded call was forwarded again")
	}

	// A user's token is not a bridge's.
	code, _, _ = ts.do(t, direct, call{method: http.MethodGet, path: basePath + "vm-local/guestinfo", header: withPeerToken(otherToken, "root")})
	if code != http.StatusUnauthorized {
		t.Fatalf("user token: %d", code)
	}
}

func TestDiscovery(t *testing.T) {
	fp, fpCA := newFrontProxy(t)
	ts := startServer(t, fp, fpCA)
	c := ts.client(fpCA.clientCert(t, "front-proxy-client"))
	// The API server's discovery calls: system:masters for /apis, and a
	// plain authenticated user for the legacy fallback.
	aggregator := asUser("system:kube-aggregator", "system:masters")

	code, out, _ := ts.do(t, c, call{method: http.MethodGet, path: "/apis/subresources.hangar.magesgate.com/v1alpha1", header: asUser("system:kube-aggregator")})
	if code != http.StatusOK {
		t.Fatalf("%d %s", code, out)
	}
	var list metav1.APIResourceList
	if err := json.Unmarshal(out, &list); err != nil {
		t.Fatal(err)
	}
	want := []metav1.APIResource{
		{Name: "virtualmachineinstances/guestinfo", Namespaced: true, Kind: "GuestInfo", Verbs: metav1.Verbs{"get"}},
		{Name: "virtualmachineinstances/guestfiles", Namespaced: true, Kind: "GuestFiles", Verbs: metav1.Verbs{"get", "create", "update", "delete"}},
	}
	if list.GroupVersion != "subresources.hangar.magesgate.com/v1alpha1" || fmt.Sprint(list.APIResources) != fmt.Sprint(want) {
		t.Errorf("APIResourceList %+v", list)
	}

	code, out, _ = ts.do(t, c, call{method: http.MethodGet, path: "/apis/subresources.hangar.magesgate.com", header: aggregator})
	var group metav1.APIGroup
	if code != http.StatusOK || json.Unmarshal(out, &group) != nil || group.PreferredVersion.Version != "v1alpha1" {
		t.Errorf("APIGroup %d %s", code, out)
	}

	code, out, _ = ts.do(t, c, call{method: http.MethodGet, path: "/apis", header: aggregator})
	var groups metav1.APIGroupList
	if code != http.StatusOK || json.Unmarshal(out, &groups) != nil || len(groups.Groups) != 1 || groups.Groups[0].Name != v1alpha1.GroupName {
		t.Errorf("APIGroupList %d %s", code, out)
	}

	h := aggregator
	h["Accept"] = []string{"application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList"}
	code, out, hdr := ts.do(t, c, call{method: http.MethodGet, path: "/apis", header: h})
	if code != http.StatusOK || !strings.Contains(hdr.Get("Content-Type"), "apidiscovery.k8s.io") {
		t.Fatalf("aggregated discovery: %d %s %s", code, hdr.Get("Content-Type"), out)
	}
	var agg apidiscoveryv2.APIGroupDiscoveryList
	if err := json.Unmarshal(out, &agg); err != nil {
		t.Fatal(err)
	}
	if len(agg.Items) != 1 || len(agg.Items[0].Versions) != 1 || len(agg.Items[0].Versions[0].Resources) != 1 {
		t.Fatalf("aggregated discovery %s", out)
	}
	parent := agg.Items[0].Versions[0].Resources[0]
	if parent.Resource != "virtualmachineinstances" || len(parent.Verbs) != 0 || parent.ResponseKind == nil || parent.ResponseKind.Kind != "" {
		t.Errorf("parent %+v: it must not be a resource of this group", parent)
	}
	var subs []string
	for _, s := range parent.Subresources {
		subs = append(subs, fmt.Sprintf("%s:%s:%v", s.Subresource, s.ResponseKind.Kind, s.Verbs))
	}
	if strings.Join(subs, " ") != "guestinfo:GuestInfo:[get] guestfiles:GuestFiles:[get create update delete]" {
		t.Errorf("subresources %v", subs)
	}

	// Discovery needs an authenticated caller too.
	if code, _, _ := ts.do(t, ts.client(), call{method: http.MethodGet, path: "/apis"}); code != http.StatusUnauthorized {
		t.Errorf("anonymous /apis: %d", code)
	}
}

func TestReadyz(t *testing.T) {
	fp, fpCA := newFrontProxy(t)
	ts := startServer(t, fp, fpCA)
	anonymous := ts.client()
	for _, p := range []string{"/readyz", "/livez", "/healthz"} {
		if code, out, _ := ts.do(t, anonymous, call{method: http.MethodGet, path: p}); code != http.StatusOK {
			t.Errorf("%s: %d %s", p, code, out)
		}
	}
	if code, out, _ := ts.do(t, anonymous, call{method: http.MethodGet, path: "/readyz?verbose"}); code != http.StatusOK || !strings.Contains(string(out), "front-proxy-ca ok") {
		t.Errorf("/readyz?verbose: %d %s", code, out)
	}
	// Anonymous calls reach the health paths only.
	for _, p := range []string{"/metrics", "/readyz/front-proxy-ca", "/version", basePath + "vm-local/guestinfo"} {
		if code, _, _ := ts.do(t, anonymous, call{method: http.MethodGet, path: p}); code != http.StatusUnauthorized {
			t.Errorf("anonymous %s: %d", p, code)
		}
	}
}

func TestReadyzWaitsForTheFrontProxyCA(t *testing.T) {
	_, fpCA := newFrontProxy(t)
	ts := startServer(t, &staticFrontProxy{CAContentProvider: unloadedCA{}}, fpCA)
	code, out, _ := ts.do(t, ts.client(), call{method: http.MethodGet, path: "/readyz?verbose"})
	if code != http.StatusInternalServerError || !strings.Contains(string(out), "front-proxy-ca failed") {
		t.Fatalf("/readyz: %d %s", code, out)
	}
	// And nothing authenticates meanwhile.
	code, _, _ = ts.do(t, ts.client(fpCA.clientCert(t, "front-proxy-client")),
		call{method: http.MethodGet, path: basePath + "vm-local/guestinfo", header: asUser("root")})
	if code != http.StatusUnauthorized {
		t.Fatalf("call before the CA is loaded: %d", code)
	}
}
