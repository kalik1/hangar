package certs

import (
	"context"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	clocktesting "k8s.io/utils/clock/testing"
)

const (
	testNamespace = "hangar-system"
	testSecret    = "hangar-guest-bridge-tls"
)

// fakePatcher is an APIService's caBundle: ensures counts the checks,
// calls the patches that changed it.
type fakePatcher struct {
	mu      sync.Mutex
	current []byte
	ensures int
	calls   [][]byte
	err     error
}

func (p *fakePatcher) EnsureCABundle(_ context.Context, ca []byte) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return false, p.err
	}
	p.ensures++
	if string(p.current) == string(ca) {
		return false, nil
	}
	p.current = ca
	p.calls = append(p.calls, ca)
	return true, nil
}

// count is the number of patches.
func (p *fakePatcher) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls)
}

func (p *fakePatcher) checks() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ensures
}

// recreate stands for an APIService deleted and applied again: no caBundle.
func (p *fakePatcher) recreate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current = nil
}

type countingListener struct{ n int }

func (l *countingListener) Enqueue() { l.n++ }

type env struct {
	client  *fake.Clientset
	clock   *clocktesting.FakeClock
	patcher *fakePatcher
	leader  bool
	m       *Manager
}

func newEnv(t *testing.T, objects ...runtime.Object) *env {
	t.Helper()
	e := &env{
		client:  fake.NewClientset(objects...),
		clock:   clocktesting.NewFakeClock(t0),
		patcher: &fakePatcher{},
	}
	e.m = NewManager(Config{
		Client:     e.client,
		Namespace:  testNamespace,
		SecretName: testSecret,
		DNSNames:   testNames,
		APIService: e.patcher,
		Clock:      e.clock,
		IsLeader:   func() bool { return e.leader },
	})
	return e
}

func (e *env) secret(t *testing.T) *corev1.Secret {
	t.Helper()
	s, err := e.client.CoreV1().Secrets(testNamespace).Get(context.Background(), testSecret, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func secretOf(b *Bundle) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: testSecret, Namespace: testNamespace, ResourceVersion: "1"},
		Type:       corev1.SecretTypeTLS,
		Data:       b.Data(),
	}
}

func countActions(c *fake.Clientset, verb string) int {
	n := 0
	for _, a := range c.Actions() {
		if a.GetVerb() == verb && a.GetResource().Resource == "secrets" {
			n++
		}
	}
	return n
}

func TestFirstPodCreatesTheSecretAndPatchesTheAPIService(t *testing.T) {
	e := newEnv(t) // not the Lease holder: the first pod need not be
	l := &countingListener{}
	e.m.AddListener(l)
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	s := e.secret(t)
	if s.Type != corev1.SecretTypeTLS {
		t.Errorf("type %q", s.Type)
	}
	b, err := Parse(s.Data)
	if err != nil {
		t.Fatal(err)
	}
	if st, why := b.Check(t0, testNames[0]); st != Fresh {
		t.Fatalf("created bundle is %v: %s", st, why)
	}
	cert, key := e.m.CurrentCertKeyContent()
	if string(cert) != string(b.Cert) || string(key) != string(b.Key) {
		t.Error("the created certificate is not the served one")
	}
	if string(e.m.CA()) != string(b.CACert) {
		t.Error("CA() is not the created CA")
	}
	if e.patcher.count() != 1 || string(e.patcher.calls[0]) != string(b.CACert) {
		t.Errorf("caBundle patches %d, want 1 with the new CA", e.patcher.count())
	}
	if l.n != 1 {
		t.Errorf("listener told %d times, want 1", l.n)
	}
	if err := e.m.WaitLoaded(context.Background()); err != nil {
		t.Error(err)
	}
	if err := e.m.Loaded(nil); err != nil {
		t.Error(err)
	}
}

func TestCreateConflictUsesTheOtherPodsSecret(t *testing.T) {
	e := newEnv(t)
	theirs := mustGenerate(t, t0)
	// The other pod's create lands between our Get and our Create.
	e.client.PrependReactor("create", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		if err := e.client.Tracker().Add(secretOf(theirs)); err != nil {
			t.Fatal(err)
		}
		return true, nil, apierrors.NewAlreadyExists(schema.GroupResource{Resource: "secrets"}, testSecret)
	})
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.m.CA() != nil {
		t.Fatal("loaded something before reading the other pod's Secret")
	}
	if e.patcher.checks() != 0 {
		t.Error("a pod that lost the create set the APIService's caBundle")
	}
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if string(e.m.CA()) != string(theirs.CACert) {
		t.Error("not serving the other pod's certificate")
	}
	if n := countActions(e.client, "create"); n != 1 {
		t.Errorf("%d creates, want 1", n)
	}
}

func TestOnlyTheLeaseHolderRenews(t *testing.T) {
	old := mustGenerate(t, t0)
	e := newEnv(t, secretOf(old))
	e.clock.SetTime(t0.Add(ServingValidity - 20*24*time.Hour)) // within 30 days of the end

	// A follower serves the old certificate and leaves the Secret alone.
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if cert, _ := e.m.CurrentCertKeyContent(); string(cert) != string(old.Cert) {
		t.Fatal("the follower does not serve the Secret's certificate")
	}
	if n := countActions(e.client, "update"); n != 0 {
		t.Fatalf("the follower updated the Secret %d times", n)
	}
	if e.patcher.checks() != 0 {
		t.Fatal("the follower read or patched the APIService")
	}

	// The Lease holder renews it with the same CA.
	e.leader = true
	e.m.StartedLeading(context.Background())
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	renewed, err := Parse(e.secret(t).Data)
	if err != nil {
		t.Fatal(err)
	}
	if string(renewed.CACert) != string(old.CACert) {
		t.Error("renewal replaced the CA")
	}
	if string(renewed.Cert) == string(old.Cert) {
		t.Fatal("the serving certificate was not renewed")
	}
	if st, why := renewed.Check(e.clock.Now(), testNames[0]); st != Fresh {
		t.Errorf("renewed bundle is %v: %s", st, why)
	}
	if cert, _ := e.m.CurrentCertKeyContent(); string(cert) != string(renewed.Cert) {
		t.Error("the Lease holder does not serve the renewed certificate")
	}
	if e.patcher.checks() != 1 || e.patcher.count() != 1 {
		t.Errorf("caBundle checks %d, patches %d; want 1 and 1 at the start of the term", e.patcher.checks(), e.patcher.count())
	}
}

func TestTheLeaseHolderReplacesAnUnusableSecret(t *testing.T) {
	broken := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: testSecret, Namespace: testNamespace, ResourceVersion: "1"},
		Data:       map[string][]byte{KeyCert: []byte("garbage")},
	}
	e := newEnv(t, broken)

	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.m.CA() != nil {
		t.Fatal("a follower loaded an unusable Secret")
	}
	if n := countActions(e.client, "update"); n != 0 {
		t.Fatal("a follower repaired the Secret")
	}

	e.leader = true
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	b, err := Parse(e.secret(t).Data)
	if err != nil {
		t.Fatalf("the Secret is still unusable: %v", err)
	}
	if string(e.m.CA()) != string(b.CACert) || e.patcher.count() != 1 {
		t.Error("the new CA is not served or not patched into the APIService")
	}
}

func TestCABundleCheckCadence(t *testing.T) {
	e := newEnv(t, secretOf(mustGenerate(t, t0)))
	e.leader = true
	ctx := context.Background()

	// The APIService does not exist yet: the error says so, and the next
	// round tries again.
	e.patcher.err = apierrors.NewNotFound(schema.GroupResource{Group: "apiregistration.k8s.io", Resource: "apiservices"}, "x")
	if err := e.m.Reconcile(ctx); err == nil {
		t.Fatal("no error for a missing APIService")
	}
	if e.m.ensured() {
		t.Fatal("ensured() after a failed patch")
	}
	e.patcher.err = nil
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if e.patcher.count() != 1 || !e.m.ensured() {
		t.Fatalf("patches %d", e.patcher.count())
	}
	// Nothing changed: no check until CheckInterval.
	e.clock.Step(time.Minute)
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if e.patcher.checks() != 1 {
		t.Fatalf("checked %d times after a minute, want 1", e.patcher.checks())
	}
	// After CheckInterval it checks, and patches nothing: the caBundle is
	// right.
	e.clock.Step(5 * time.Minute)
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if e.patcher.checks() != 2 || e.patcher.count() != 1 {
		t.Fatalf("after CheckInterval: %d checks, %d patches; want 2 and 1", e.patcher.checks(), e.patcher.count())
	}
	// The APIService was applied again without a caBundle: the next check
	// sets it.
	e.patcher.recreate()
	e.clock.Step(5 * time.Minute)
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if e.patcher.count() != 2 {
		t.Fatalf("a recreated APIService was not patched (%d patches)", e.patcher.count())
	}
	// A new term checks at once.
	e.m.StartedLeading(ctx)
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if e.patcher.checks() != 4 || e.patcher.count() != 2 {
		t.Fatalf("at the start of a term: %d checks, %d patches; want 4 and 2", e.patcher.checks(), e.patcher.count())
	}
}

func TestFollowerPicksUpARenewal(t *testing.T) {
	first := mustGenerate(t, t0)
	e := newEnv(t, secretOf(first))
	l := &countingListener{}
	e.m.AddListener(l)
	ctx := context.Background()
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if l.n != 1 {
		t.Fatalf("listener told %d times for one certificate", l.n)
	}
	renewed, err := first.Renewed(t0, testNames)
	if err != nil {
		t.Fatal(err)
	}
	s := e.secret(t)
	s.Data = renewed.Data()
	if _, err := e.client.CoreV1().Secrets(testNamespace).Update(ctx, s, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if cert, _ := e.m.CurrentCertKeyContent(); string(cert) != string(renewed.Cert) || l.n != 2 {
		t.Errorf("follower did not load the renewal (listener told %d times)", l.n)
	}
}

func TestRunLoadsAndStops(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.m.Run(ctx); close(done) }()
	wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
	defer wcancel()
	if err := e.m.WaitLoaded(wctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
}
