package server

import (
	"errors"
	"net/http"
	"time"

	"k8s.io/apiserver/pkg/apis/apiserver"
	"k8s.io/apiserver/pkg/authentication/authenticator"
	"k8s.io/apiserver/pkg/authentication/authenticatorfactory"
	"k8s.io/apiserver/pkg/authentication/group"
	"k8s.io/apiserver/pkg/authentication/request/anonymous"
	"k8s.io/apiserver/pkg/authentication/request/headerrequest"
	unionauthn "k8s.io/apiserver/pkg/authentication/request/union"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/apiserver/pkg/authorization/authorizer"
	"k8s.io/apiserver/pkg/authorization/authorizerfactory"
	"k8s.io/apiserver/pkg/authorization/path"
	unionauthz "k8s.io/apiserver/pkg/authorization/union"
	"k8s.io/apiserver/pkg/server/dynamiccertificates"
	"k8s.io/apiserver/pkg/server/options"
	"k8s.io/client-go/kubernetes"
	authorizationclient "k8s.io/client-go/kubernetes/typed/authorization/v1"
)

// healthPaths are open to anonymous calls, for the kubelet's probes. No
// other path is.
var healthPaths = []string{"/healthz", "/livez", "/readyz"}

// The ConfigMap the API server publishes its front-proxy settings in.
const (
	authenticationConfigMapNamespace = "kube-system"
	authenticationConfigMapName      = "extension-apiserver-authentication"
)

// FrontProxy is the API server's front-proxy settings: the CA of its proxy
// client certificate, the names that certificate may carry, and the headers
// it passes the caller in.
type FrontProxy interface {
	dynamiccertificates.CAContentProvider
	headerrequest.RequestHeaderAuthRequestProvider
}

// NewFrontProxy returns the front-proxy settings that the API server
// publishes in kube-system/extension-apiserver-authentication, kept up to
// date by watching the ConfigMap. The server runs its controllers.
func NewFrontProxy(client kubernetes.Interface) (*options.DynamicRequestHeaderController, error) {
	ca, err := dynamiccertificates.NewDynamicCAFromConfigMapController("front-proxy-ca",
		authenticationConfigMapNamespace, authenticationConfigMapName, "requestheader-client-ca-file", client)
	if err != nil {
		return nil, err
	}
	headers := headerrequest.NewRequestHeaderAuthRequestController(
		authenticationConfigMapName, authenticationConfigMapNamespace, client,
		"requestheader-username-headers",
		"requestheader-uid-headers",
		"requestheader-group-headers",
		"requestheader-extra-headers-prefix",
		"requestheader-allowed-names",
	)
	return &options.DynamicRequestHeaderController{
		ConfigMapCAController:              ca,
		RequestHeaderAuthRequestController: headers,
	}, nil
}

// FrontProxyLoaded is a readyz check: the front-proxy CA is loaded. Until it
// is, no call can be authenticated.
func FrontProxyLoaded(fp FrontProxy) func(*http.Request) error {
	return func(*http.Request) error {
		if _, ok := fp.VerifyOptions(); !ok {
			return errors.New("the front-proxy CA (kube-system/extension-apiserver-authentication, requestheader-client-ca-file) is not loaded")
		}
		return nil
	}
}

func requestHeaderConfig(fp FrontProxy) *authenticatorfactory.RequestHeaderConfig {
	return &authenticatorfactory.RequestHeaderConfig{
		CAContentProvider:   fp,
		UsernameHeaders:     headerrequest.StringSliceProviderFunc(fp.UsernameHeaders),
		UIDHeaders:          headerrequest.StringSliceProviderFunc(fp.UIDHeaders),
		GroupHeaders:        headerrequest.StringSliceProviderFunc(fp.GroupHeaders),
		ExtraHeaderPrefixes: headerrequest.StringSliceProviderFunc(fp.ExtraHeaderPrefixes),
		AllowedClientNames:  headerrequest.StringSliceProviderFunc(fp.AllowedClientNames),
	}
}

// NewAuthenticator returns the bridge's authenticator. It accepts:
//
//   - a call the API server proxies: a client certificate signed by the
//     front-proxy CA, with an allowed name, and the caller in the front-proxy
//     headers;
//   - a call another bridge pod forwards, when peer is not nil;
//   - an anonymous call to the health paths only.
//
// Every other call is refused, including one with a client certificate of
// the cluster's client CA or a user's bearer token: a call must come
// through the API server.
func NewAuthenticator(fp FrontProxy, peer authenticator.Request) authenticator.Request {
	rh := requestHeaderConfig(fp)
	frontProxy := headerrequest.NewDynamicVerifyOptionsSecure(rh.CAContentProvider.VerifyOptions,
		rh.AllowedClientNames, rh.UsernameHeaders, rh.UIDHeaders, rh.GroupHeaders, rh.ExtraHeaderPrefixes)
	authenticators := []authenticator.Request{group.NewAuthenticatedGroupAdder(frontProxy)}
	if peer != nil {
		// The forwarded caller already carries system:authenticated, and
		// keeps its peer.ForwardedUser type.
		authenticators = append(authenticators, peer)
	}
	conditions := make([]apiserver.AnonymousAuthCondition, 0, len(healthPaths))
	for _, p := range healthPaths {
		conditions = append(conditions, apiserver.AnonymousAuthCondition{Path: p})
	}
	// A request with bad credentials fails; one without any is anonymous on
	// the health paths, and refused elsewhere.
	return unionauthn.NewFailOnError(unionauthn.New(authenticators...), anonymous.NewAuthenticator(conditions))
}

// NewAuthorizer returns the bridge's authorizer: a SubjectAccessReview for
// each call (cached 10 s), as defence in depth behind the API server's own
// check; the health paths for anyone; and everything for system:masters,
// which the API server's discovery calls use.
func NewAuthorizer(sar authorizationclient.AuthorizationV1Interface) (authorizer.Authorizer, error) {
	delegated, err := authorizerfactory.DelegatingAuthorizerConfig{
		SubjectAccessReviewClient: sar,
		AllowCacheTTL:             10 * time.Second,
		DenyCacheTTL:              10 * time.Second,
		WebhookRetryBackoff:       options.DefaultAuthWebhookRetryBackoff(),
	}.New()
	if err != nil {
		return nil, err
	}
	paths, err := path.NewAuthorizer(healthPaths)
	if err != nil {
		return nil, err
	}
	return unionauthz.New(authorizerfactory.NewPrivilegedGroups(user.SystemPrivilegedGroup), paths, delegated), nil
}
