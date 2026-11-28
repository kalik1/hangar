package app_test

// This test runs two bridges ("node-a" and "node-b") behind a real
// kube-apiserver and etcd (envtest), with no KubeVirt: a CRD stands in for
// its VMIs. The bridges run with the RBAC the cluster bundle must give them.
// It needs the envtest binaries, either installed:
//
//	KUBEBUILDER_ASSETS=$(setup-envtest use -p path 1.36.x) go test ./internal/app/
//
// or downloaded by the test (as CI does):
//
//	HANGAR_ENVTEST_DOWNLOAD=v1.36.2 go test ./internal/app/
//
// and is skipped without either.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/app"
	"github.com/kalik1/hangar/bridge/internal/certs"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/peer"
)

const (
	ns    = app.DefaultNamespace
	vmsNS = "vms"
	// downloadEnv names the Kubernetes version of envtest binaries to
	// download.
	downloadEnv = "HANGAR_ENVTEST_DOWNLOAD"
)

var (
	apiServiceGVR = schema.GroupVersionResource{Group: "apiregistration.k8s.io", Version: "v1", Resource: "apiservices"}
	vmiGVR        = schema.GroupVersionResource{Group: "kubevirt.io", Version: "v1", Resource: "virtualmachineinstances"}
	bridges       = []struct{ node, pod, ip string }{
		{"node-a", "hangar-guest-bridge-a", "127.0.0.2"},
		{"node-b", "hangar-guest-bridge-b", "127.0.0.3"},
	}
)

type cluster struct {
	dir   string
	env   *envtest.Environment
	admin *rest.Config
	kube  kubernetes.Interface
	dyn   dynamic.Interface
	port  int
}

func TestBridgeBehindTheAPIServer(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" && os.Getenv(downloadEnv) == "" {
		t.Skipf("neither KUBEBUILDER_ASSETS nor %s is set", downloadEnv)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	c := startCluster(t)
	c.install(ctx, t)

	bridgeCtx, stopBridges := context.WithCancel(ctx)
	stopped := c.runBridges(bridgeCtx, t)
	defer func() {
		stopBridges()
		for range bridges {
			if err := <-stopped; err != nil && !errors.Is(err, context.Canceled) {
				t.Errorf("a bridge stopped with %v", err)
			}
		}
	}()
	c.waitAvailable(ctx, t)

	alice := c.user(t, "alice", "devs") // guestinfo get on vm-a and vm-b
	bob := c.user(t, "bob")             // guestfiles, all verbs, on vm-b only
	carol := c.user(t, "carol")         // nothing

	t.Run("discovery lists the two subresources", func(t *testing.T) {
		dc := discovery.NewDiscoveryClientForConfigOrDie(alice)
		list, err := dc.ServerResourcesForGroupVersion(v1alpha1.SchemeGroupVersion.String())
		if err != nil {
			t.Fatal(err)
		}
		checkResources(t, "legacy", list.APIResources)

		_, lists, err := dc.ServerGroupsAndResources()
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, l := range lists {
			if l.GroupVersion == v1alpha1.SchemeGroupVersion.String() {
				found = true
				checkResources(t, "aggregated", l.APIResources)
			}
		}
		if !found {
			t.Error("the aggregated discovery has no subresources.hangar.magesgate.com/v1alpha1")
		}
	})

	type tc struct {
		name, method, vm, sub string
		as                    *rest.Config
		want                  int
		node                  string // the bridge that serves it
	}
	for _, k := range []tc{
		{"viewer: guestinfo on this node", http.MethodGet, "vm-a", "guestinfo", alice, 200, "node-a"},
		{"viewer: guestinfo forwarded to node-b", http.MethodGet, "vm-b", "guestinfo", alice, 200, "node-b"},
		{"viewer: no guestfiles", http.MethodGet, "vm-a", "guestfiles", alice, 403, ""},
		{"viewer: no write", http.MethodPut, "vm-b", "guestfiles", alice, 403, ""},
		{"guest admin: get", http.MethodGet, "vm-b", "guestfiles", bob, 200, "node-b"},
		{"guest admin: create", http.MethodPost, "vm-b", "guestfiles", bob, 200, "node-b"},
		{"guest admin: update", http.MethodPut, "vm-b", "guestfiles", bob, 200, "node-b"},
		{"guest admin: delete", http.MethodDelete, "vm-b", "guestfiles", bob, 200, "node-b"},
		{"guest admin: patch is no verb of the role", http.MethodPatch, "vm-b", "guestfiles", bob, 403, ""},
		{"guest admin: resourceNames keep vm-a out", http.MethodGet, "vm-a", "guestfiles", bob, 403, ""},
		{"guest admin: no guestinfo", http.MethodGet, "vm-b", "guestinfo", bob, 403, ""},
		{"no role", http.MethodGet, "vm-a", "guestinfo", carol, 403, ""},
		{"cluster admin: patch is no verb of guestfiles", http.MethodPatch, "vm-b", "guestfiles", c.admin, 405, ""},
		{"cluster admin: a missing VMI", http.MethodGet, "vm-missing", "guestinfo", c.admin, 404, ""},
		{"cluster admin: a stopped VMI", http.MethodGet, "vm-stopped", "guestinfo", c.admin, 409, ""},
	} {
		t.Run(k.name, func(t *testing.T) {
			path := fmt.Sprintf("/apis/%s/namespaces/%s/virtualmachineinstances/%s/%s?op=x", v1alpha1.SchemeGroupVersion, vmsNS, k.vm, k.sub)
			var body io.Reader
			if k.method != http.MethodGet && k.method != http.MethodDelete {
				body = strings.NewReader(`{}`)
			}
			code, out := do(t, k.as, k.method, path, body)
			if code != k.want {
				t.Fatalf("%s %s: %d, want %d: %s", k.method, path, code, k.want, out)
			}
			if code != 200 {
				// What the bridge refuses comes back as its Status, not
				// as the API server's own 404.
				var st metav1.Status
				if k.want != 403 && (json.Unmarshal(out, &st) != nil || st.Kind != "Status" || int(st.Code) != k.want) {
					t.Errorf("not the bridge's Status: %s", out)
				}
				return
			}
			var e echo
			if err := json.Unmarshal(out, &e); err != nil {
				t.Fatal(err)
			}
			wantUser := k.as.Username
			if wantUser == "" {
				wantUser = userOf(t, k.as)
			}
			if e.Node != k.node || e.Target != vmsNS+"/"+k.vm || e.Subresource != k.sub || e.User != wantUser ||
				!slices.Contains(e.Groups, user.AllAuthenticated) || e.Forwarded != (k.node != "node-a") {
				t.Errorf("echo %+v", e)
			}
		})
	}

	t.Run("the caller's groups reach the forwarded call", func(t *testing.T) {
		code, out := do(t, alice, http.MethodGet, "/apis/"+v1alpha1.SchemeGroupVersion.String()+"/namespaces/vms/virtualmachineinstances/vm-b/guestinfo", nil)
		var e echo
		if code != 200 || json.Unmarshal(out, &e) != nil || !slices.Contains(e.Groups, "devs") {
			t.Fatalf("%d %s", code, out)
		}
	})

	caPEM := c.servingCA(ctx, t)
	t.Run("the APIService trusts the bridge's CA", func(t *testing.T) {
		as, err := c.dyn.Resource(apiServiceGVR).Get(ctx, app.APIServiceName, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		bundle, _, _ := unstructured.NestedString(as.Object, "spec", "caBundle")
		if got, err := base64.StdEncoding.DecodeString(bundle); err != nil || string(got) != string(caPEM) {
			t.Fatalf("caBundle %q is not the Secret's CA (%v)", bundle, err)
		}
		lease, err := c.kube.CoordinationV1().Leases(ns).Get(ctx, app.LeaseName, metav1.GetOptions{})
		if err != nil || lease.Spec.HolderIdentity == nil || !strings.HasPrefix(*lease.Spec.HolderIdentity, "hangar-guest-bridge-") {
			t.Fatalf("lease %v, %v", lease, err)
		}
	})

	t.Run("a call that does not come from the API server is refused", func(t *testing.T) {
		for _, b := range bridges {
			code, out := direct(t, caPEM, b.ip, c.port, nil, map[string]string{"X-Remote-User": "system:admin", "X-Remote-Group": "system:masters"})
			if code != http.StatusUnauthorized {
				t.Errorf("%s: %d %s", b.node, code, out)
			}
			// A user's own client certificate, of the cluster CA.
			code, out = direct(t, caPEM, b.ip, c.port, alice, nil)
			if code != http.StatusUnauthorized {
				t.Errorf("%s with a user certificate: %d %s", b.node, code, out)
			}
		}
	})

	t.Run("a peer's token does not bypass authorization", func(t *testing.T) {
		token, err := os.ReadFile(c.tokenFile(t, bridges[0].pod))
		if err != nil {
			t.Fatal(err)
		}
		hdr := map[string]string{
			"Authorization":  "Bearer " + strings.TrimSpace(string(token)),
			"X-Remote-User":  "carol",
			"X-Remote-Group": user.AllAuthenticated,
		}
		code, out := direct(t, caPEM, bridges[1].ip, c.port, nil, hdr)
		if code != http.StatusForbidden {
			t.Fatalf("carol via a peer token: %d %s", code, out)
		}
		hdr["X-Remote-User"] = "alice"
		code, out = direct(t, caPEM, bridges[1].ip, c.port, nil, hdr)
		if code != http.StatusOK {
			t.Fatalf("alice via a peer token: %d %s", code, out)
		}
	})
}

// --- the cluster --------------------------------------------------------------

func startCluster(t *testing.T) *cluster {
	t.Helper()
	dir := t.TempDir()
	caFile, certFile, keyFile := frontProxyFiles(t, dir)
	env := &envtest.Environment{CRDs: []*apiextensionsv1.CustomResourceDefinition{vmiCRD()}}
	if v := os.Getenv(downloadEnv); v != "" && os.Getenv("KUBEBUILDER_ASSETS") == "" {
		env.DownloadBinaryAssets = true
		env.DownloadBinaryAssetsVersion = v
		env.BinaryAssetsDirectory = filepath.Join(os.TempDir(), "hangar-envtest")
	}
	args := env.ControlPlane.GetAPIServer().Configure()
	args.Set("requestheader-client-ca-file", caFile)
	args.Set("requestheader-allowed-names", "front-proxy-client")
	args.Set("requestheader-username-headers", "X-Remote-User")
	args.Set("requestheader-uid-headers", "X-Remote-Uid")
	args.Set("requestheader-group-headers", "X-Remote-Group")
	args.Set("requestheader-extra-headers-prefix", "X-Remote-Extra-")
	args.Set("proxy-client-cert-file", certFile)
	args.Set("proxy-client-key-file", keyFile)
	cfg, err := env.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = env.Stop() })
	return &cluster{
		dir:   dir,
		env:   env,
		admin: cfg,
		kube:  kubernetes.NewForConfigOrDie(cfg),
		dyn:   dynamic.NewForConfigOrDie(cfg),
		port:  freePort(t),
	}
}

// install creates what the cluster bundle will: the namespace, the
// ServiceAccount and its RBAC, the Service and the APIService; and what
// KubeVirt and the kubelet would: VMIs, and the bridge pods' status.
func (c *cluster) install(ctx context.Context, t *testing.T) {
	t.Helper()
	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []string{ns, vmsNS} {
		must(c.kube.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: n}}, metav1.CreateOptions{}))
	}
	must(c.kube.CoreV1().ServiceAccounts(ns).Create(ctx, &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: app.ServiceAccountName}}, metav1.CreateOptions{}))
	sa := []rbacv1.Subject{{Kind: "ServiceAccount", Name: app.ServiceAccountName, Namespace: ns}}

	// The bridge's RBAC: what distribution/guest-bridge must grant.
	must(c.kube.RbacV1().ClusterRoles().Create(ctx, &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: "hangar-guest-bridge"},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{"kubevirt.io"}, Resources: []string{"virtualmachineinstances"}, Verbs: []string{"get"}},
			{APIGroups: []string{"apiregistration.k8s.io"}, Resources: []string{"apiservices"}, Verbs: []string{"patch"}, ResourceNames: []string{app.APIServiceName}},
		},
	}, metav1.CreateOptions{}))
	for _, role := range []string{"hangar-guest-bridge", "system:auth-delegator"} {
		must(c.kube.RbacV1().ClusterRoleBindings().Create(ctx, &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "hangar-guest-bridge:" + strings.TrimPrefix(role, "system:")},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: role},
			Subjects:   sa,
		}, metav1.CreateOptions{}))
	}
	must(c.kube.RbacV1().Roles(ns).Create(ctx, &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: "hangar-guest-bridge"},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list", "watch"}},
			{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"create"}},
			{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get", "update"}, ResourceNames: []string{app.SecretName}},
			{APIGroups: []string{"coordination.k8s.io"}, Resources: []string{"leases"}, Verbs: []string{"create"}},
			{APIGroups: []string{"coordination.k8s.io"}, Resources: []string{"leases"}, Verbs: []string{"get", "update"}, ResourceNames: []string{app.LeaseName}},
		},
	}, metav1.CreateOptions{}))
	must(c.kube.RbacV1().RoleBindings(ns).Create(ctx, &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "hangar-guest-bridge"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "hangar-guest-bridge"},
		Subjects:   sa,
	}, metav1.CreateOptions{}))
	must(c.kube.RbacV1().RoleBindings("kube-system").Create(ctx, &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "hangar-guest-bridge:extension-apiserver-authentication-reader"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "extension-apiserver-authentication-reader"},
		Subjects:   sa,
	}, metav1.CreateOptions{}))

	// The users' roles.
	userRole := func(name, sub string, verbs []string, vms []string, who string) {
		must(c.kube.RbacV1().Roles(vmsNS).Create(ctx, &rbacv1.Role{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Rules: []rbacv1.PolicyRule{{
				APIGroups: []string{v1alpha1.GroupName}, Resources: []string{"virtualmachineinstances/" + sub},
				Verbs: verbs, ResourceNames: vms,
			}},
		}, metav1.CreateOptions{}))
		must(c.kube.RbacV1().RoleBindings(vmsNS).Create(ctx, &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: name},
			Subjects:   []rbacv1.Subject{{APIGroup: "rbac.authorization.k8s.io", Kind: "User", Name: who}},
		}, metav1.CreateOptions{}))
	}
	userRole("guest-viewer", "guestinfo", []string{"get"}, []string{"vm-a", "vm-b"}, "alice")
	userRole("guest-admin-vm-b", "guestfiles", []string{"get", "create", "update", "delete"}, []string{"vm-b"}, "bob")

	// The Service and the APIService. The aggregator reaches node-a's bridge
	// through an ExternalName (envtest has no kube-proxy), with the TLS name
	// of the real Service. The bridge sets the caBundle.
	must(c.kube.CoreV1().Services(ns).Create(ctx, &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: app.ServiceName},
		Spec:       corev1.ServiceSpec{Type: corev1.ServiceTypeExternalName, ExternalName: bridges[0].ip},
	}, metav1.CreateOptions{}))
	must(c.dyn.Resource(apiServiceGVR).Create(ctx, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiregistration.k8s.io/v1",
		"kind":       "APIService",
		"metadata":   map[string]any{"name": app.APIServiceName},
		"spec": map[string]any{
			"group":                v1alpha1.GroupName,
			"version":              v1alpha1.Version,
			"groupPriorityMinimum": int64(1000),
			"versionPriority":      int64(15),
			"service":              map[string]any{"namespace": ns, "name": app.ServiceName, "port": int64(c.port)},
		},
	}}, metav1.CreateOptions{}))

	// The bridge pods, as the kubelet reports them.
	for _, b := range bridges {
		pod, err := c.kube.CoreV1().Pods(ns).Create(ctx, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: b.pod, Labels: map[string]string{"app.kubernetes.io/name": "hangar-guest-bridge"}},
			Spec: corev1.PodSpec{
				NodeName:           b.node,
				ServiceAccountName: app.ServiceAccountName,
				Containers:         []corev1.Container{{Name: "bridge", Image: "example.invalid/bridge"}},
			},
		}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		pod.Status = corev1.PodStatus{
			Phase:      corev1.PodRunning,
			PodIP:      b.ip,
			PodIPs:     []corev1.PodIP{{IP: b.ip}},
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
		}
		must(c.kube.CoreV1().Pods(ns).UpdateStatus(ctx, pod, metav1.UpdateOptions{}))
	}

	// The VMIs, as KubeVirt reports them.
	for name, status := range map[string]map[string]any{
		"vm-a":       {"phase": "Running", "nodeName": "node-a", "activePods": map[string]any{"launcher-a": "node-a"}},
		"vm-b":       {"phase": "Running", "nodeName": "node-b", "activePods": map[string]any{"launcher-b": "node-b"}},
		"vm-stopped": {"phase": "Succeeded", "nodeName": "node-a", "activePods": map[string]any{"launcher-s": "node-a"}},
	} {
		must(c.dyn.Resource(vmiGVR).Namespace(vmsNS).Create(ctx, &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "kubevirt.io/v1",
			"kind":       "VirtualMachineInstance",
			"metadata":   map[string]any{"name": name},
			"status":     status,
		}}, metav1.CreateOptions{}))
	}
}

// runBridges starts the two bridges with ServiceAccount tokens, as their
// pods would have them.
func (c *cluster) runBridges(ctx context.Context, t *testing.T) <-chan error {
	t.Helper()
	stopped := make(chan error, len(bridges))
	apiToken := c.token(ctx, t, nil)
	for _, b := range bridges {
		cfg := rest.AnonymousClientConfig(c.admin)
		cfg.BearerToken = apiToken
		cfg.QPS, cfg.Burst = 50, 100
		opts := app.Options{
			RESTConfig:    cfg,
			BindAddress:   b.ip,
			SecurePort:    c.port,
			Namespace:     ns,
			NodeName:      b.node,
			PodName:       b.pod,
			PeerTokenFile: c.tokenFile(t, b.pod),
			Handlers: func(context.Context, app.Env) (map[string]guest.Handler, error) {
				h := guest.HandlerFunc(echoHandler(b.node))
				return map[string]guest.Handler{v1alpha1.GuestInfo: h, v1alpha1.GuestFiles: h}, nil
			},
			LeaseDuration: 4 * time.Second,
			RenewDeadline: 3 * time.Second,
			RetryPeriod:   time.Second,
		}
		go func() { stopped <- app.Run(ctx, opts) }()
	}
	return stopped
}

func (c *cluster) token(ctx context.Context, t *testing.T, audiences []string) string {
	t.Helper()
	tr, err := c.kube.CoreV1().ServiceAccounts(ns).CreateToken(ctx, app.ServiceAccountName, &authenticationv1.TokenRequest{
		Spec: authenticationv1.TokenRequestSpec{Audiences: audiences, ExpirationSeconds: ptr.To[int64](3600)},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return tr.Status.Token
}

// tokenFile is the projected token of audience hangar-guest-bridge.
func (c *cluster) tokenFile(t *testing.T, pod string) string {
	t.Helper()
	p := filepath.Join(c.dir, pod+"-peer-token")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	if err := os.WriteFile(p, []byte(c.token(context.Background(), t, []string{peer.Audience})), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func (c *cluster) waitAvailable(ctx context.Context, t *testing.T) {
	t.Helper()
	var last string
	err := wait.PollUntilContextTimeout(ctx, 250*time.Millisecond, 90*time.Second, true, func(ctx context.Context) (bool, error) {
		as, err := c.dyn.Resource(apiServiceGVR).Get(ctx, app.APIServiceName, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		conds, _, _ := unstructured.NestedSlice(as.Object, "status", "conditions")
		for _, cond := range conds {
			m, _ := cond.(map[string]any)
			if m["type"] == "Available" {
				last = fmt.Sprintf("%v: %v", m["reason"], m["message"])
				return m["status"] == "True", nil
			}
		}
		return false, nil
	})
	if err != nil {
		t.Fatalf("the APIService is not Available: %v (%s)", err, last)
	}
}

func (c *cluster) servingCA(ctx context.Context, t *testing.T) []byte {
	t.Helper()
	s, err := c.kube.CoreV1().Secrets(ns).Get(ctx, app.SecretName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := certs.Parse(s.Data)
	if err != nil {
		t.Fatal(err)
	}
	if st, why := b.Check(time.Now(), app.ServiceDNSNames(ns)[0]); st != certs.Fresh {
		t.Fatalf("the bridge's Secret is %v: %s", st, why)
	}
	return b.CACert
}

func (c *cluster) user(t *testing.T, name string, groups ...string) *rest.Config {
	t.Helper()
	u, err := c.env.AddUser(envtest.User{Name: name, Groups: groups}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return u.Config()
}

// --- helpers -----------------------------------------------------------------

type echo struct {
	Node        string   `json:"node"`
	Target      string   `json:"target"`
	Subresource string   `json:"subresource"`
	Verb        string   `json:"verb"`
	User        string   `json:"user"`
	Groups      []string `json:"groups"`
	Forwarded   bool     `json:"forwarded"`
}

func echoHandler(node string) func(http.ResponseWriter, *http.Request, guest.Call) {
	return func(w http.ResponseWriter, r *http.Request, c guest.Call) {
		_, _ = io.Copy(io.Discard, r.Body)
		if c.Target.Node != node {
			guest.WriteError(w, fmt.Errorf("served on %s for a VMI on %s", node, c.Target.Node))
			return
		}
		guest.WriteObject(w, http.StatusOK, echo{
			Node: node, Target: c.Target.String(), Subresource: c.Subresource, Verb: c.Verb,
			User: c.User.GetName(), Groups: c.User.GetGroups(), Forwarded: peer.IsForwarded(c.User),
		})
	}
}

func checkResources(t *testing.T, what string, got []metav1.APIResource) {
	t.Helper()
	var names []string
	for _, r := range got {
		names = append(names, fmt.Sprintf("%s:%s:%v:%v", r.Name, r.Kind, r.Namespaced, r.Verbs))
	}
	want := []string{
		"virtualmachineinstances/guestinfo:GuestInfo:true:[get]",
		"virtualmachineinstances/guestfiles:GuestFiles:true:[get create update delete]",
	}
	if !slices.Equal(names, want) {
		t.Errorf("%s discovery %v, want %v", what, names, want)
	}
}

func do(t *testing.T, cfg *rest.Config, method, path string, body io.Reader) (int, []byte) {
	t.Helper()
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, strings.TrimSuffix(cfg.Host, "/")+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if method == http.MethodPatch {
		req.Header.Set("Content-Type", "application/merge-patch+json")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

// direct calls a bridge pod without the API server, with the client
// certificate of cfg if any.
func direct(t *testing.T, caPEM []byte, ip string, port int, cfg *rest.Config, headers map[string]string) (int, []byte) {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	tlsCfg := &tls.Config{RootCAs: pool, ServerName: app.ServiceDNSNames(ns)[0], MinVersion: tls.VersionTLS12}
	if cfg != nil {
		pair, err := tls.X509KeyPair(cfg.CertData, cfg.KeyData)
		if err != nil {
			t.Fatal(err)
		}
		tlsCfg.Certificates = []tls.Certificate{pair}
	}
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: tlsCfg}}
	url := fmt.Sprintf("https://%s/apis/%s/namespaces/vms/virtualmachineinstances/vm-b/guestinfo",
		net.JoinHostPort(ip, strconv.Itoa(port)), v1alpha1.SchemeGroupVersion)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func userOf(t *testing.T, cfg *rest.Config) string {
	t.Helper()
	block, _ := pem.Decode(cfg.CertData)
	if block == nil {
		t.Fatal("no client certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return cert.Subject.CommonName
}

// freePort returns a port free on both bridges' addresses.
func freePort(t *testing.T) int {
	t.Helper()
	for range 20 {
		l, err := net.Listen("tcp", bridges[0].ip+":0")
		if err != nil {
			t.Skipf("cannot listen on %s: %v", bridges[0].ip, err)
		}
		port := l.Addr().(*net.TCPAddr).Port
		l2, err := net.Listen("tcp", net.JoinHostPort(bridges[1].ip, strconv.Itoa(port)))
		_ = l.Close()
		if err == nil {
			_ = l2.Close()
			return port
		}
	}
	t.Fatal("no free port")
	return 0
}

func vmiCRD() *apiextensionsv1.CustomResourceDefinition {
	return &apiextensionsv1.CustomResourceDefinition{
		ObjectMeta: metav1.ObjectMeta{Name: "virtualmachineinstances.kubevirt.io"},
		Spec: apiextensionsv1.CustomResourceDefinitionSpec{
			Group: "kubevirt.io",
			Names: apiextensionsv1.CustomResourceDefinitionNames{
				Plural: "virtualmachineinstances", Singular: "virtualmachineinstance",
				Kind: "VirtualMachineInstance", ListKind: "VirtualMachineInstanceList", ShortNames: []string{"vmi"},
			},
			Scope: apiextensionsv1.NamespaceScoped,
			Versions: []apiextensionsv1.CustomResourceDefinitionVersion{{
				Name: "v1", Served: true, Storage: true,
				Schema: &apiextensionsv1.CustomResourceValidation{OpenAPIV3Schema: &apiextensionsv1.JSONSchemaProps{
					Type: "object", XPreserveUnknownFields: ptr.To(true),
				}},
			}},
		},
	}
}

// frontProxyFiles writes the API server's front-proxy CA and its proxy
// client certificate.
func frontProxyFiles(t *testing.T, dir string) (caFile, certFile, keyFile string) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "front-proxy-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, caKey.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "front-proxy-client"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, key.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	caFile, certFile, keyFile = filepath.Join(dir, "front-proxy-ca.crt"), filepath.Join(dir, "front-proxy-client.crt"), filepath.Join(dir, "front-proxy-client.key")
	for file, block := range map[string]*pem.Block{
		caFile:   {Type: "CERTIFICATE", Bytes: caDER},
		certFile: {Type: "CERTIFICATE", Bytes: der},
		keyFile:  {Type: "PRIVATE KEY", Bytes: keyDER},
	} {
		if err := os.WriteFile(file, pem.EncodeToMemory(block), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return caFile, certFile, keyFile
}
