// Package app wires the guest bridge together and runs it.
package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/uuid"
	"k8s.io/apiserver/pkg/server/healthz"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
	"k8s.io/klog/v2"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/certs"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/peer"
	"github.com/kalik1/hangar/bridge/internal/server"
	"github.com/kalik1/hangar/bridge/internal/vmi"
)

// The names the bundle (distribution/guest-bridge) gives the bridge's
// objects. They are fixed: the API is approved with them.
const (
	DefaultNamespace = "hangar-system"
	// ServiceName is the Service the APIService points at; the serving
	// certificate is for <ServiceName>.<namespace>.svc.
	ServiceName = "hangar-guest-bridge"
	// ServiceAccountName is the bridge's ServiceAccount: a forwarded call
	// must carry its token.
	ServiceAccountName = "hangar-guest-bridge"
	// SecretName is the Secret of the CA and the serving certificate.
	SecretName = "hangar-guest-bridge-tls"
	// LeaseName is the Lease whose holder renews the certificate.
	LeaseName = "hangar-guest-bridge"
	// PodSelector selects the bridge's pods, the forwarding targets.
	PodSelector = "app.kubernetes.io/name=hangar-guest-bridge"
	// DefaultPeerTokenFile is where the projected token of audience
	// peer.Audience is mounted.
	DefaultPeerTokenFile = "/var/run/secrets/hangar-guest-bridge/token"
	// DefaultSecurePort is the bridge's port, the Service's targetPort, and
	// the port bridge pods forward to.
	DefaultSecurePort = 8443
)

// APIServiceName is the bridge's APIService.
var APIServiceName = v1alpha1.Version + "." + v1alpha1.GroupName

// Env is what the subresource handlers get from the bridge.
type Env struct {
	// Kube and Dynamic are the bridge's own API clients.
	Kube    kubernetes.Interface
	Dynamic dynamic.Interface
	// NodeName is this pod's node: every call a handler gets is for a VMI
	// on it.
	NodeName  string
	Namespace string
}

// HandlersFunc builds the subresource handlers, by subresource name (see
// v1alpha1.Subresources). ctx ends when the bridge stops: background work
// such as connections to the launchers ends with it.
type HandlersFunc func(ctx context.Context, env Env) (map[string]guest.Handler, error)

// Options configures Run.
type Options struct {
	// RESTConfig is the bridge's own access to the API server.
	RESTConfig *rest.Config
	// BindAddress and SecurePort make the listener.
	BindAddress string
	SecurePort  int
	// Namespace is the bridge's namespace; NodeName and PodName are its
	// pod's, from the downward API.
	Namespace string
	NodeName  string
	PodName   string
	// PeerTokenFile is the projected token of audience peer.Audience.
	PeerTokenFile string
	// ShutdownDelay keeps serving after SIGTERM while /readyz fails.
	ShutdownDelay time.Duration
	// Handlers builds the subresource handlers. Nil serves none (501).
	Handlers HandlersFunc

	// Lease timings; zero means 30 s, 20 s and 5 s.
	LeaseDuration, RenewDeadline, RetryPeriod time.Duration
}

// Validate checks the options.
func (o *Options) Validate() error {
	var errs []error
	if o.RESTConfig == nil {
		errs = append(errs, errors.New("no API server configuration"))
	}
	if o.NodeName == "" {
		errs = append(errs, errors.New("the node name is required (NODE_NAME)"))
	}
	if o.PodName == "" {
		errs = append(errs, errors.New("the pod name is required (POD_NAME)"))
	}
	if o.Namespace == "" {
		errs = append(errs, errors.New("the namespace is required (POD_NAMESPACE)"))
	}
	if o.SecurePort <= 0 || o.SecurePort > 65535 {
		errs = append(errs, fmt.Errorf("bad secure port %d", o.SecurePort))
	}
	return errors.Join(errs...)
}

// Run runs the bridge until ctx ends.
func Run(ctx context.Context, o Options) error {
	if err := o.Validate(); err != nil {
		return err
	}
	kube, err := kubernetes.NewForConfig(o.RESTConfig)
	if err != nil {
		return err
	}
	dyn, err := dynamic.NewForConfig(o.RESTConfig)
	if err != nil {
		return err
	}

	// Certificates first: nothing serves without them.
	el := &elector{}
	certManager := certs.NewManager(certs.Config{
		Client:     kube,
		Namespace:  o.Namespace,
		SecretName: SecretName,
		DNSNames:   ServiceDNSNames(o.Namespace),
		APIService: certs.NewAPIServicePatcher(dyn, APIServiceName),
		IsLeader:   el.IsLeader,
	})
	el.cfg = electionConfig(kube, o, certManager.StartedLeading)
	go el.run(ctx)
	go certManager.Run(ctx)
	klog.InfoS("Waiting for the guest bridge's serving certificate", "secret", certManager.Name())
	if err := certManager.WaitLoaded(ctx); err != nil {
		return err
	}

	frontProxy, err := server.NewFrontProxy(kube)
	if err != nil {
		return err
	}
	if err := frontProxy.RunOnce(ctx); err != nil {
		// Not fatal: the controller keeps watching, and /readyz says so.
		klog.ErrorS(err, "Reading the API server's front-proxy settings")
	}

	selector, err := labels.Parse(PodSelector)
	if err != nil {
		return err
	}
	podInformers := informers.NewSharedInformerFactoryWithOptions(kube, 0,
		informers.WithNamespace(o.Namespace),
		informers.WithTweakListOptions(func(lo *metav1.ListOptions) { lo.LabelSelector = PodSelector }))
	pods := podInformers.Core().V1().Pods().Lister().Pods(o.Namespace)

	peerAuth, err := peer.NewAuthenticator(peer.AuthenticatorConfig{
		TokenReviews:   kube.AuthenticationV1().TokenReviews(),
		Namespace:      o.Namespace,
		ServiceAccount: ServiceAccountName,
	})
	if err != nil {
		return err
	}
	authz, err := server.NewAuthorizer(kube.AuthorizationV1())
	if err != nil {
		return err
	}

	var handlers map[string]guest.Handler
	if o.Handlers != nil {
		env := Env{Kube: kube, Dynamic: dyn, NodeName: o.NodeName, Namespace: o.Namespace}
		if handlers, err = o.Handlers(ctx, env); err != nil {
			return err
		}
	}
	dispatcher := &server.Dispatcher{
		NodeName: o.NodeName,
		Locator:  vmi.NewLocator(dyn),
		Peers:    peer.NewDirectory(pods, selector),
		Forward: &peer.Forwarder{
			Port:       o.SecurePort,
			ServerName: ServiceDNSNames(o.Namespace)[0],
			CA:         certManager.CA,
			TokenFile:  o.PeerTokenFile,
		},
		Handlers: handlers,
	}

	listener, err := net.Listen("tcp", net.JoinHostPort(o.BindAddress, strconv.Itoa(o.SecurePort)))
	if err != nil {
		return err
	}
	srv, err := server.New(server.Config{
		Listener:      listener,
		ServingCert:   certManager,
		FrontProxy:    frontProxy,
		Peer:          peerAuth,
		Authorizer:    authz,
		Dispatcher:    dispatcher,
		Informers:     podInformers,
		ReadyzChecks:  []healthz.HealthChecker{healthz.NamedCheck("serving-certificate", certManager.Loaded)},
		ShutdownDelay: o.ShutdownDelay,
	})
	if err != nil {
		_ = listener.Close()
		return err
	}
	klog.InfoS("Serving the guest bridge", "address", listener.Addr().String(), "node", o.NodeName, "group", v1alpha1.SchemeGroupVersion.String())
	return srv.PrepareRun().RunWithContext(ctx)
}

// ServiceDNSNames are the serving certificate's names; the first is the one
// the API server checks.
func ServiceDNSNames(namespace string) []string {
	return []string{
		ServiceName + "." + namespace + ".svc",
		ServiceName + "." + namespace + ".svc.cluster.local",
		ServiceName + "." + namespace,
		ServiceName,
	}
}

// elector campaigns for the Lease until ctx ends, again after each loss.
type elector struct {
	cfg     leaderelection.LeaderElectionConfig
	current atomic.Pointer[leaderelection.LeaderElector]
}

func electionConfig(kube kubernetes.Interface, o Options, started func(context.Context)) leaderelection.LeaderElectionConfig {
	lease := o.Namespace + "/" + LeaseName
	return leaderelection.LeaderElectionConfig{
		Lock: &resourcelock.LeaseLock{
			LeaseMeta:  metav1.ObjectMeta{Name: LeaseName, Namespace: o.Namespace},
			Client:     kube.CoordinationV1(),
			LockConfig: resourcelock.ResourceLockConfig{Identity: o.PodName + "_" + string(uuid.NewUUID())},
		},
		LeaseDuration:   orDefault(o.LeaseDuration, 30*time.Second),
		RenewDeadline:   orDefault(o.RenewDeadline, 20*time.Second),
		RetryPeriod:     orDefault(o.RetryPeriod, 5*time.Second),
		ReleaseOnCancel: true,
		Name:            LeaseName,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(ctx context.Context) {
				klog.InfoS("Holding the guest bridge's Lease", "lease", lease)
				started(ctx)
			},
			OnStoppedLeading: func() {
				klog.InfoS("Not holding the guest bridge's Lease", "lease", lease)
			},
		},
	}
}

// IsLeader reports whether this pod holds the Lease.
func (e *elector) IsLeader() bool {
	le := e.current.Load()
	return le != nil && le.IsLeader()
}

func (e *elector) run(ctx context.Context) {
	for ctx.Err() == nil {
		le, err := leaderelection.NewLeaderElector(e.cfg)
		if err != nil {
			klog.ErrorS(err, "Leader election")
			return
		}
		e.current.Store(le)
		le.Run(ctx)
	}
}

func orDefault(d, def time.Duration) time.Duration {
	if d == 0 {
		return def
	}
	return d
}
