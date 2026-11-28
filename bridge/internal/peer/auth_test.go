package peer

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	authenticationv1 "k8s.io/api/authentication/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

const (
	bridgeToken = "bridge-token"
	otherToken  = "other-sa-token"
	wrongAud    = "wrong-audience-token"
	bridgeUser  = "system:serviceaccount:hangar-system:hangar-guest-bridge"
)

// fakeTokenReviews answers TokenReviews like the API server would for three
// tokens, and counts them.
func fakeTokenReviews(t *testing.T) (*fake.Clientset, *int) {
	t.Helper()
	client := fake.NewClientset()
	calls := 0
	client.PrependReactor("create", "tokenreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		calls++
		tr := a.(k8stesting.CreateAction).GetObject().(*authenticationv1.TokenReview)
		if !slices.Equal(tr.Spec.Audiences, []string{Audience}) {
			t.Errorf("TokenReview audiences %v", tr.Spec.Audiences)
		}
		out := tr.DeepCopy()
		switch tr.Spec.Token {
		case bridgeToken:
			out.Status = authenticationv1.TokenReviewStatus{
				Authenticated: true,
				Audiences:     []string{Audience},
				User: authenticationv1.UserInfo{
					Username: bridgeUser,
					Groups:   []string{"system:serviceaccounts", "system:authenticated"},
					Extra:    map[string]authenticationv1.ExtraValue{"authentication.kubernetes.io/pod-name": {"hangar-guest-bridge-abcde"}},
				},
			}
		case otherToken:
			out.Status = authenticationv1.TokenReviewStatus{
				Authenticated: true,
				Audiences:     []string{Audience},
				User:          authenticationv1.UserInfo{Username: "system:serviceaccount:vms:default"},
			}
		case wrongAud:
			// An API server that ignores the requested audience.
			out.Status = authenticationv1.TokenReviewStatus{
				Authenticated: true,
				Audiences:     []string{"https://kubernetes.default.svc"},
				User:          authenticationv1.UserInfo{Username: bridgeUser},
			}
		default:
			out.Status = authenticationv1.TokenReviewStatus{Authenticated: false, Error: "invalid bearer token"}
		}
		return true, out, nil
	})
	return client, &calls
}

func newTestAuthenticator(t *testing.T) (*requestAuthenticator, *int) {
	t.Helper()
	client, calls := fakeTokenReviews(t)
	a, err := NewAuthenticator(AuthenticatorConfig{
		TokenReviews:   client.AuthenticationV1().TokenReviews(),
		Namespace:      "hangar-system",
		ServiceAccount: "hangar-guest-bridge",
	})
	if err != nil {
		t.Fatal(err)
	}
	return a.(*requestAuthenticator), calls
}

func forwardedRequest(token string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestinfo", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("X-Remote-User", "alice")
	r.Header.Set("X-Remote-Uid", "alice-uid")
	r.Header.Add("X-Remote-Group", "devs")
	r.Header.Add("X-Remote-Group", "system:authenticated")
	r.Header.Set("X-Remote-Extra-Scopes", "a")
	r.Header.Set("X-Remote-Extra-Example.com%2fteam", "blue")
	return r
}

func TestForwardedCallWithTheBridgesToken(t *testing.T) {
	a, calls := newTestAuthenticator(t)
	r := forwardedRequest(bridgeToken)
	resp, ok, err := a.AuthenticateRequest(r)
	if err != nil || !ok {
		t.Fatalf("ok %v err %v", ok, err)
	}
	if !IsForwarded(resp.User) {
		t.Error("the caller is not marked as forwarded")
	}
	u := resp.User
	if u.GetName() != "alice" || u.GetUID() != "alice-uid" {
		t.Errorf("user %q uid %q", u.GetName(), u.GetUID())
	}
	if !slices.Equal(u.GetGroups(), []string{"devs", "system:authenticated"}) {
		t.Errorf("groups %v", u.GetGroups())
	}
	if ex := u.GetExtra(); !slices.Equal(ex["scopes"], []string{"a"}) || !slices.Equal(ex["example.com/team"], []string{"blue"}) {
		t.Errorf("extra %v", ex)
	}
	if r.Header.Get("Authorization") != "" {
		t.Error("the bridge's token is still on the request")
	}
	// The same token again is answered from the cache.
	if _, ok, err := a.AuthenticateRequest(forwardedRequest(bridgeToken)); err != nil || !ok {
		t.Fatalf("second call: ok %v err %v", ok, err)
	}
	if *calls != 1 {
		t.Errorf("%d TokenReviews for one token, want 1", *calls)
	}
}

func TestForwardedCallsRefused(t *testing.T) {
	cases := map[string]func(*http.Request){
		"invalid token":           func(r *http.Request) { r.Header.Set("Authorization", "Bearer forged") },
		"another account":         func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+otherToken) },
		"wrong audience":          func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+wrongAud) },
		"no caller":               func(r *http.Request) { r.Header.Del("X-Remote-User") },
		"impersonation headers":   func(r *http.Request) { r.Header.Set("Impersonate-User", "admin") },
		"impersonation, any case": func(r *http.Request) { r.Header["IMPERSONATE-GROUP"] = []string{"system:masters"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			a, _ := newTestAuthenticator(t)
			r := forwardedRequest(bridgeToken)
			mutate(r)
			resp, ok, err := a.AuthenticateRequest(r)
			if ok || err == nil {
				t.Fatalf("accepted: ok %v err %v user %v", ok, err, resp)
			}
		})
	}
}

func TestNoBearerTokenIsNotThePeersBusiness(t *testing.T) {
	a, calls := newTestAuthenticator(t)
	for _, auth := range []string{"", "Basic YWxpY2U6c2VjcmV0", "Bearer   "} {
		r := forwardedRequest("")
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		resp, ok, err := a.AuthenticateRequest(r)
		if ok || err != nil || resp != nil {
			t.Errorf("%q: ok %v err %v", auth, ok, err)
		}
	}
	if *calls != 0 {
		t.Errorf("%d TokenReviews without a bearer token", *calls)
	}
}

func TestIsForwarded(t *testing.T) {
	if IsForwarded(&user.DefaultInfo{Name: "alice"}) {
		t.Error("a plain user is forwarded")
	}
	if !IsForwarded(&ForwardedUser{Info: &user.DefaultInfo{Name: "alice"}}) {
		t.Error("a ForwardedUser is not forwarded")
	}
}
