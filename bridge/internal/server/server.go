// Package server is the guest bridge's aggregated API server, on
// k8s.io/apiserver's generic API server: front-proxy authentication,
// delegated authorization, discovery of subresources.hangar.magesgate.com,
// and the dispatch of each call to the bridge pod of the VMI's node.
package server

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"

	apidiscoveryv2 "k8s.io/api/apidiscovery/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"k8s.io/apiserver/pkg/authentication/authenticator"
	"k8s.io/apiserver/pkg/authorization/authorizer"
	"k8s.io/apiserver/pkg/endpoints"
	"k8s.io/apiserver/pkg/endpoints/discovery"
	genericapiserver "k8s.io/apiserver/pkg/server"
	"k8s.io/apiserver/pkg/server/dynamiccertificates"
	"k8s.io/apiserver/pkg/server/healthz"
	"k8s.io/apiserver/pkg/util/compatibility"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/rest"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

// Name is the server's name in its logs and metrics.
const Name = "hangar-guest-bridge"

var (
	// Scheme knows the types the server writes itself: discovery and
	// Status.
	Scheme = runtime.NewScheme()
	// Codecs serializes them.
	Codecs = serializer.NewCodecFactory(Scheme)
)

func init() {
	metav1.AddToGroupVersion(Scheme, schema.GroupVersion{Version: "v1"})
	Scheme.AddUnversionedTypes(schema.GroupVersion{Group: "", Version: "v1"},
		&metav1.Status{}, &metav1.APIVersions{}, &metav1.APIGroupList{}, &metav1.APIGroup{}, &metav1.APIResourceList{})
}

// Config configures the server.
type Config struct {
	// Listener is the secure port.
	Listener net.Listener
	// ServingCert is the serving certificate.
	ServingCert dynamiccertificates.CertKeyContentProvider
	// FrontProxy is the API server's front-proxy settings. If it is a
	// dynamiccertificates.ControllerRunner, the server runs it.
	FrontProxy FrontProxy
	// Peer authenticates the calls other bridge pods forward. Nil refuses
	// them.
	Peer authenticator.Request
	// Authorizer authorizes every call (NewAuthorizer).
	Authorizer authorizer.Authorizer
	// Dispatcher serves the subresource calls.
	Dispatcher http.Handler
	// Informers are started with the server; /readyz waits for their sync.
	Informers informers.SharedInformerFactory
	// ReadyzChecks are added to /readyz, which gates the Service.
	ReadyzChecks []healthz.HealthChecker
	// ShutdownDelay keeps serving for that long after SIGTERM, with /readyz
	// failing, so that the endpoints drop the pod first.
	ShutdownDelay time.Duration
}

// New returns the server. Run it with PrepareRun().RunWithContext.
func New(cfg Config) (*genericapiserver.GenericAPIServer, error) {
	c := genericapiserver.NewConfig(Codecs)
	c.EffectiveVersion = compatibility.DefaultBuildEffectiveVersion()
	// The bridge makes no calls to itself, so it needs no loopback client,
	// and with no loopback token there is no token it accepts on its own.
	c.LoopbackClientConfig = &rest.Config{}
	c.EnableProfiling = false
	c.ShutdownDelayDuration = cfg.ShutdownDelay
	c.SecureServing = &genericapiserver.SecureServingInfo{
		Listener:      cfg.Listener,
		Cert:          cfg.ServingCert,
		MinTLSVersion: tls.VersionTLS12,
	}
	c.Authentication.Authenticator = NewAuthenticator(cfg.FrontProxy, cfg.Peer)
	// So that the authentication filter removes the front-proxy headers
	// whatever their names.
	c.Authentication.RequestHeaderConfig = requestHeaderConfig(cfg.FrontProxy)
	// The TLS handshake asks for a client certificate of the front-proxy CA.
	if err := c.Authentication.ApplyClientCert(cfg.FrontProxy, c.SecureServing); err != nil {
		return nil, err
	}
	c.Authorization.Authorizer = cfg.Authorizer
	c.ReadyzChecks = append(c.ReadyzChecks,
		healthz.NamedCheck("front-proxy-ca", FrontProxyLoaded(cfg.FrontProxy)))
	c.ReadyzChecks = append(c.ReadyzChecks, cfg.ReadyzChecks...)

	s, err := c.Complete(cfg.Informers).New(Name, genericapiserver.NewEmptyDelegate())
	if err != nil {
		return nil, err
	}
	if err := installAPI(s, cfg.Dispatcher); err != nil {
		return nil, err
	}
	return s, nil
}

// installAPI adds the group to discovery and serves its paths:
//
//	/apis/{group}                 the APIGroup
//	/apis/{group}/{version}       the APIResourceList: the two subresources
//	/apis/{group}/{version}/...   the calls, to the dispatcher
//
// /apis lists the group in both the legacy and the aggregated discovery
// formats; the aggregated form is derived from the legacy list as the API
// server does it for servers that serve only the legacy one.
func installAPI(s *genericapiserver.GenericAPIServer, dispatcher http.Handler) error {
	group := v1alpha1.APIGroup()
	s.DiscoveryGroupManager.AddGroup(group)
	resources, err := endpoints.ConvertGroupVersionIntoToDiscovery(v1alpha1.APIResources())
	if err != nil {
		return fmt.Errorf("aggregated discovery: %w", err)
	}
	s.AggregatedDiscoveryGroupManager.AddGroupVersion(v1alpha1.GroupName, apidiscoveryv2.APIVersionDiscovery{
		Version:   v1alpha1.Version,
		Resources: resources,
		Freshness: apidiscoveryv2.DiscoveryFreshnessCurrent,
	})

	groupPath := "/apis/" + v1alpha1.GroupName
	versionPath := groupPath + "/" + v1alpha1.Version
	groupHandler := discovery.NewAPIGroupHandler(Codecs, group)
	versionHandler := discovery.NewAPIVersionHandler(Codecs, v1alpha1.SchemeGroupVersion,
		discovery.APIResourceListerFunc(v1alpha1.APIResources))
	mux := s.Handler.NonGoRestfulMux
	mux.Handle(groupPath, groupHandler)
	mux.Handle(groupPath+"/", groupHandler)
	mux.Handle(versionPath, versionHandler)
	mux.HandlePrefix(versionPath+"/", dispatcher)
	return nil
}
