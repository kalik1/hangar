package certs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apiserver/pkg/server/dynamiccertificates"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/klog/v2"
	"k8s.io/utils/clock"
)

// APIServiceGVR is the resource of APIServices.
var APIServiceGVR = schema.GroupVersionResource{Group: "apiregistration.k8s.io", Version: "v1", Resource: "apiservices"}

// CABundlePatcher sets the caBundle of the bridge's APIService.
type CABundlePatcher interface {
	PatchCABundle(ctx context.Context, caPEM []byte) error
}

// NewAPIServicePatcher returns a CABundlePatcher of the named APIService. It
// needs only the patch verb on it, and never creates it: removing the bridge
// deletes the APIService first.
func NewAPIServicePatcher(client dynamic.Interface, name string) CABundlePatcher {
	return &apiServicePatcher{client: client, name: name}
}

type apiServicePatcher struct {
	client dynamic.Interface
	name   string
}

func (p *apiServicePatcher) PatchCABundle(ctx context.Context, caPEM []byte) error {
	patch, err := json.Marshal(map[string]any{"spec": map[string]any{"caBundle": caPEM}})
	if err != nil {
		return err
	}
	_, err = p.client.Resource(APIServiceGVR).Patch(ctx, p.name, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

// Config configures a Manager.
type Config struct {
	Client kubernetes.Interface
	// Namespace and SecretName name the Secret of the certificates.
	Namespace  string
	SecretName string
	// DNSNames are the serving certificate's names. The first one is the
	// name the API server checks: <service>.<namespace>.svc.
	DNSNames []string
	// APIService sets the APIService's caBundle.
	APIService CABundlePatcher
	// IsLeader reports whether this pod holds the Lease. Nil means never.
	IsLeader func() bool
	// Clock is the time source; nil means the real clock.
	Clock clock.PassiveClock

	// SyncInterval is how often the Secret is read once loaded. Zero means
	// a minute.
	SyncInterval time.Duration
	// PatchInterval is how often the Lease holder sets the caBundle again
	// when it is not known to have changed, in case the APIService was
	// recreated. Zero means 5 minutes.
	PatchInterval time.Duration
}

// Manager keeps the bridge's certificates. It is the server's serving
// certificate provider.
type Manager struct {
	cfg Config

	current   atomic.Pointer[Bundle]
	loaded    chan struct{}
	onceReady sync.Once
	kick      chan struct{}

	mu        sync.Mutex
	listeners []dynamiccertificates.Listener
	patchedCA []byte
	patchedAt time.Time
}

var _ dynamiccertificates.CertKeyContentProvider = &Manager{}

// NewManager returns a Manager. Run starts it.
func NewManager(cfg Config) *Manager {
	if cfg.Clock == nil {
		cfg.Clock = clock.RealClock{}
	}
	if cfg.SyncInterval == 0 {
		cfg.SyncInterval = time.Minute
	}
	if cfg.PatchInterval == 0 {
		cfg.PatchInterval = 5 * time.Minute
	}
	return &Manager{cfg: cfg, loaded: make(chan struct{}), kick: make(chan struct{}, 1)}
}

// Name names the certificate for the server's logs.
func (m *Manager) Name() string { return "secret/" + m.cfg.Namespace + "/" + m.cfg.SecretName }

// CurrentCertKeyContent returns the serving certificate and key in PEM.
func (m *Manager) CurrentCertKeyContent() ([]byte, []byte) {
	b := m.current.Load()
	if b == nil {
		return nil, nil
	}
	return b.Cert, b.Key
}

// AddListener registers a listener that is told when the certificate changes.
func (m *Manager) AddListener(l dynamiccertificates.Listener) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.listeners = append(m.listeners, l)
}

// CA returns the CA certificate in PEM, or nil before the first load.
func (m *Manager) CA() []byte {
	if b := m.current.Load(); b != nil {
		return b.CACert
	}
	return nil
}

// WaitLoaded blocks until a certificate is loaded, or ctx ends.
func (m *Manager) WaitLoaded(ctx context.Context) error {
	select {
	case <-m.loaded:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Loaded is a readyz check: a serving certificate is loaded.
func (m *Manager) Loaded(*http.Request) error {
	if m.current.Load() == nil {
		return errors.New("no serving certificate loaded yet")
	}
	return nil
}

// StartedLeading is leader election's OnStartedLeading. The Lease holder's
// duties (renewal, repair and the APIService's caBundle) start at once, and a
// new term sets the caBundle at its start.
func (m *Manager) StartedLeading(context.Context) {
	m.mu.Lock()
	m.patchedCA = nil
	m.mu.Unlock()
	m.Kick()
}

func (m *Manager) isLeader() bool {
	return m.cfg.IsLeader != nil && m.cfg.IsLeader()
}

// Kick makes Run reconcile now.
func (m *Manager) Kick() {
	select {
	case m.kick <- struct{}{}:
	default:
	}
}

// Run reconciles the Secret until ctx ends: every 2 s until a certificate
// is loaded, every 10 s while the Lease holder has not set the caBundle,
// and every SyncInterval after that.
func (m *Manager) Run(ctx context.Context) {
	for {
		if err := m.Reconcile(ctx); err != nil && ctx.Err() == nil {
			klog.ErrorS(err, "Reconciling the guest bridge's certificates", "secret", m.Name())
		}
		wait := m.cfg.SyncInterval
		switch {
		case m.current.Load() == nil:
			wait = 2 * time.Second
		case m.isLeader() && !m.patched():
			wait = 10 * time.Second
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-m.kick:
			t.Stop()
		case <-t.C:
		}
	}
}

// Reconcile reads the Secret once and acts on it. Every pod creates a
// missing Secret and loads a usable one; the Lease holder also renews or
// replaces it, and sets the caBundle.
func (m *Manager) Reconcile(ctx context.Context) error {
	leader := m.isLeader()
	now := m.cfg.Clock.Now()
	secrets := m.cfg.Client.CoreV1().Secrets(m.cfg.Namespace)

	secret, err := secrets.Get(ctx, m.cfg.SecretName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		b, err := Generate(now, m.cfg.DNSNames)
		if err != nil {
			return err
		}
		_, err = secrets.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:      m.cfg.SecretName,
				Namespace: m.cfg.Namespace,
				Labels:    map[string]string{"app.kubernetes.io/name": "hangar-guest-bridge", "app.kubernetes.io/part-of": "hangar"},
			},
			Type: corev1.SecretTypeTLS,
			Data: b.Data(),
		}, metav1.CreateOptions{})
		if apierrors.IsAlreadyExists(err) {
			// Another pod created it first: read theirs.
			m.Kick()
			return nil
		}
		if err != nil {
			return fmt.Errorf("creating the Secret: %w", err)
		}
		klog.InfoS("Created the guest bridge's CA and serving certificate", "secret", m.Name(), "notAfter", b.NotAfter())
		m.load(b)
		return m.patch(ctx, b, true)
	}
	if err != nil {
		return fmt.Errorf("reading the Secret: %w", err)
	}

	b, err := Parse(secret.Data)
	state, reason := Replace, ""
	if err != nil {
		reason = err.Error()
	} else {
		state, reason = b.Check(now, m.cfg.DNSNames[0])
	}
	if state != Replace {
		m.load(b)
	}
	if !leader {
		if state == Replace {
			klog.InfoS("The guest bridge's Secret is not usable; waiting for the Lease holder to replace it", "secret", m.Name(), "reason", reason)
		}
		return nil
	}

	if state != Fresh {
		var next *Bundle
		if state == Renew {
			next, err = b.Renewed(now, m.cfg.DNSNames)
		} else {
			next, err = Generate(now, m.cfg.DNSNames)
		}
		if err != nil {
			return err
		}
		updated := secret.DeepCopy()
		updated.Data = next.Data()
		if _, err := secrets.Update(ctx, updated, metav1.UpdateOptions{}); err != nil {
			// A conflict means another pod changed it: the next round reads it.
			return fmt.Errorf("updating the Secret (%s): %w", state, err)
		}
		klog.InfoS("Updated the guest bridge's certificates", "secret", m.Name(), "action", state.String(), "reason", reason, "notAfter", next.NotAfter())
		m.load(next)
		b = next
	}
	return m.patch(ctx, b, false)
}

// patch sets the APIService's caBundle when the CA changed, when the term or
// the bundle is new, or every PatchInterval.
func (m *Manager) patch(ctx context.Context, b *Bundle, force bool) error {
	now := m.cfg.Clock.Now()
	m.mu.Lock()
	due := force || !bytes.Equal(m.patchedCA, b.CACert) || now.Sub(m.patchedAt) >= m.cfg.PatchInterval
	m.mu.Unlock()
	if !due {
		return nil
	}
	if err := m.cfg.APIService.PatchCABundle(ctx, b.CACert); err != nil {
		if apierrors.IsNotFound(err) {
			return fmt.Errorf("setting the APIService's caBundle: the APIService does not exist (yet): %w", err)
		}
		return fmt.Errorf("setting the APIService's caBundle: %w", err)
	}
	m.mu.Lock()
	m.patchedCA, m.patchedAt = bytes.Clone(b.CACert), now
	m.mu.Unlock()
	return nil
}

func (m *Manager) patched() bool {
	b := m.current.Load()
	m.mu.Lock()
	defer m.mu.Unlock()
	return b != nil && bytes.Equal(m.patchedCA, b.CACert)
}

// load makes b the served bundle, and tells the listeners when it changed.
func (m *Manager) load(b *Bundle) {
	old := m.current.Load()
	if old != nil && bytes.Equal(old.Cert, b.Cert) && bytes.Equal(old.Key, b.Key) && bytes.Equal(old.CACert, b.CACert) {
		return
	}
	m.current.Store(b)
	m.onceReady.Do(func() { close(m.loaded) })
	m.mu.Lock()
	listeners := append([]dynamiccertificates.Listener(nil), m.listeners...)
	m.mu.Unlock()
	for _, l := range listeners {
		l.Enqueue()
	}
	if old != nil {
		klog.InfoS("Loaded a new guest bridge certificate", "secret", m.Name(), "notAfter", b.NotAfter())
	}
}
