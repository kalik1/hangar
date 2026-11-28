// Package peer forwards a call to the bridge pod on the VMI's node, and
// authenticates the calls that bridge pods forward.
//
// A bridge pod that receives a call for a VMI on another node forwards it to
// the bridge pod on that node with its projected ServiceAccount token
// (audience Audience) as a bearer token, and the caller's identity in the
// X-Remote-* headers. The receiver checks the token with a TokenReview: it
// must be valid for Audience and belong to the bridge's own ServiceAccount.
// Only then does it take the identity from the headers, and it authorizes
// that identity again with a SubjectAccessReview, as for any call.
package peer

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apiserver/pkg/authentication/authenticator"
	"k8s.io/apiserver/pkg/authentication/request/headerrequest"
	"k8s.io/apiserver/pkg/authentication/serviceaccount"
	tokencache "k8s.io/apiserver/pkg/authentication/token/cache"
	"k8s.io/apiserver/pkg/authentication/user"
	authenticationclient "k8s.io/client-go/kubernetes/typed/authentication/v1"
)

// Audience is the audience of the token a bridge pod forwards a call with.
const Audience = "hangar-guest-bridge"

// The headers that carry the caller's identity on a forwarded call. They are
// the standard front-proxy names, read only from a call whose bearer token
// is the bridge's own.
var (
	userHeaders         = []string{"X-Remote-User"}
	uidHeaders          = []string{"X-Remote-Uid"}
	groupHeaders        = []string{"X-Remote-Group"}
	extraHeaderPrefixes = []string{"X-Remote-Extra-"}
)

// ForwardedUser is the caller of a call that another bridge pod forwarded.
// The server never forwards such a call again.
type ForwardedUser struct {
	user.Info
}

// IsForwarded reports whether u is the caller of a forwarded call.
func IsForwarded(u user.Info) bool {
	_, ok := u.(*ForwardedUser)
	return ok
}

// AuthenticatorConfig configures NewAuthenticator.
type AuthenticatorConfig struct {
	// TokenReviews is the API the tokens are checked with.
	TokenReviews authenticationclient.TokenReviewInterface
	// Namespace and ServiceAccount name the bridge's own ServiceAccount.
	Namespace      string
	ServiceAccount string
	// CacheTTL is how long a TokenReview's answer is kept. Zero means 10 s.
	CacheTTL time.Duration
}

// NewAuthenticator returns the authenticator of forwarded calls.
//
// A request without a bearer token is not its business: it returns false
// and no error, and the next authenticator decides. A request with a bearer
// token that is not a bridge pod's, or that names no caller, is refused.
func NewAuthenticator(cfg AuthenticatorConfig) (authenticator.Request, error) {
	ttl := cfg.CacheTTL
	if ttl == 0 {
		ttl = 10 * time.Second
	}
	identity, err := headerrequest.New(userHeaders, uidHeaders, groupHeaders, extraHeaderPrefixes)
	if err != nil {
		return nil, err
	}
	reviewer := &tokenReviewer{client: cfg.TokenReviews}
	return &requestAuthenticator{
		tokens:   tokencache.New(reviewer, false, ttl, ttl),
		peer:     serviceaccount.MakeUsername(cfg.Namespace, cfg.ServiceAccount),
		identity: identity,
	}, nil
}

type requestAuthenticator struct {
	tokens   authenticator.Token
	peer     string
	identity authenticator.Request
}

func (a *requestAuthenticator) AuthenticateRequest(req *http.Request) (*authenticator.Response, bool, error) {
	token, ok := bearerToken(req)
	if !ok {
		return nil, false, nil
	}
	resp, ok, err := a.tokens.AuthenticateToken(req.Context(), token)
	if err != nil {
		return nil, false, fmt.Errorf("peer token: %w", err)
	}
	if !ok {
		return nil, false, errors.New("peer token: not authenticated")
	}
	if name := resp.User.GetName(); name != a.peer {
		return nil, false, fmt.Errorf("peer token: %q is not the guest bridge's ServiceAccount", name)
	}
	for name := range req.Header {
		if strings.HasPrefix(strings.ToLower(name), "impersonate-") {
			return nil, false, errors.New("peer call: impersonation headers are not allowed on a forwarded call")
		}
	}
	caller, ok, err := a.identity.AuthenticateRequest(req)
	if err != nil {
		return nil, false, fmt.Errorf("peer call: %w", err)
	}
	if !ok || caller.User.GetName() == "" {
		return nil, false, errors.New("peer call: the forwarded call does not name its caller")
	}
	// The bridge's token is not needed beyond this point.
	req.Header.Del("Authorization")
	return &authenticator.Response{User: &ForwardedUser{Info: caller.User}}, true, nil
}

func bearerToken(req *http.Request) (string, bool) {
	auth := strings.TrimSpace(req.Header.Get("Authorization"))
	scheme, token, found := strings.Cut(auth, " ")
	if !found || !strings.EqualFold(scheme, "bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// tokenReviewer checks a token with a TokenReview for Audience.
type tokenReviewer struct {
	client authenticationclient.TokenReviewInterface
}

func (r *tokenReviewer) AuthenticateToken(ctx context.Context, token string) (*authenticator.Response, bool, error) {
	review, err := r.client.Create(ctx, &authenticationv1.TokenReview{
		Spec: authenticationv1.TokenReviewSpec{Token: token, Audiences: []string{Audience}},
	}, metav1.CreateOptions{})
	if err != nil {
		return nil, false, err
	}
	st := review.Status
	if !st.Authenticated {
		// Not an error, so that the cache keeps the answer for a while.
		return nil, false, nil
	}
	if !slices.Contains(st.Audiences, Audience) {
		return nil, false, fmt.Errorf("the token is not for audience %q", Audience)
	}
	extra := make(map[string][]string, len(st.User.Extra))
	for k, v := range st.User.Extra {
		extra[k] = v
	}
	return &authenticator.Response{
		Audiences: st.Audiences,
		User: &user.DefaultInfo{
			Name:   st.User.Username,
			UID:    st.User.UID,
			Groups: st.User.Groups,
			Extra:  extra,
		},
	}, true, nil
}
