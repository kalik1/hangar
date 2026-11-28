package certs

import (
	"context"
	"encoding/base64"
	"slices"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	clocktesting "k8s.io/utils/clock/testing"
)

const testAPIService = "v1alpha1.subresources.hangar.magesgate.com"

func apiService(caBundle []byte) *unstructured.Unstructured {
	spec := map[string]any{
		"group":                "subresources.hangar.magesgate.com",
		"version":              "v1alpha1",
		"groupPriorityMinimum": int64(1000),
		"versionPriority":      int64(15),
		"service":              map[string]any{"namespace": testNamespace, "name": "hangar-guest-bridge", "port": int64(443)},
	}
	if caBundle != nil {
		spec["caBundle"] = base64.StdEncoding.EncodeToString(caBundle)
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiregistration.k8s.io/v1",
		"kind":       "APIService",
		"metadata":   map[string]any{"name": testAPIService},
		"spec":       spec,
	}}
}

func newDynamic(objects ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{APIServiceGVR: "APIServiceList"}, objects...)
}

func verbs(c *dynamicfake.FakeDynamicClient) []string {
	var out []string
	for _, a := range c.Actions() {
		if a.GetResource() == APIServiceGVR {
			out = append(out, a.GetVerb())
		}
	}
	return out
}

func caBundleOf(t *testing.T, c *dynamicfake.FakeDynamicClient) string {
	t.Helper()
	as, err := c.Resource(APIServiceGVR).Get(context.Background(), testAPIService, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	s, _, _ := unstructured.NestedString(as.Object, "spec", "caBundle")
	got, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("caBundle %q: %v", s, err)
	}
	return string(got)
}

func TestEnsureCABundlePatchesOnlyADifferentCABundle(t *testing.T) {
	ca := mustGenerate(t, t0).CACert
	other := mustGenerate(t, t0).CACert
	for _, k := range []struct {
		name      string
		current   []byte
		wantVerbs []string
	}{
		{"no caBundle (as the bundle ships it)", nil, []string{"get", "patch"}},
		{"another CA", other, []string{"get", "patch"}},
		{"the same CA", ca, []string{"get"}},
	} {
		t.Run(k.name, func(t *testing.T) {
			c := newDynamic(apiService(k.current))
			changed, err := NewAPIServicePatcher(c, testAPIService).EnsureCABundle(context.Background(), ca)
			if err != nil {
				t.Fatal(err)
			}
			if got := verbs(c); !slices.Equal(got, k.wantVerbs) {
				t.Errorf("calls %v, want %v", got, k.wantVerbs)
			}
			if changed != (len(k.wantVerbs) == 2) {
				t.Errorf("changed %v", changed)
			}
			if caBundleOf(t, c) != string(ca) {
				t.Error("the caBundle is not the CA")
			}
		})
	}
}

func TestEnsureCABundleOfAMissingAPIService(t *testing.T) {
	c := newDynamic()
	_, err := NewAPIServicePatcher(c, testAPIService).EnsureCABundle(context.Background(), mustGenerate(t, t0).CACert)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("error %v, want NotFound", err)
	}
	if got := verbs(c); len(got) != 1 || got[0] != "get" {
		t.Errorf("calls %v: the patcher must never create the APIService", got)
	}
}

// The Lease holder checks the caBundle every CheckInterval; an APIService
// that already trusts the CA gets no PATCH.
func TestTheLeaseHolderDoesNotPatchAnUnchangedAPIService(t *testing.T) {
	dyn := newDynamic(apiService(nil))
	clock := clocktesting.NewFakeClock(t0)
	m := NewManager(Config{
		Client:     fake.NewClientset(secretOf(mustGenerate(t, t0))),
		Namespace:  testNamespace,
		SecretName: testSecret,
		DNSNames:   testNames,
		APIService: NewAPIServicePatcher(dyn, testAPIService),
		Clock:      clock,
		IsLeader:   func() bool { return true },
	})
	ctx := context.Background()
	m.StartedLeading(ctx)
	for range 4 {
		if err := m.Reconcile(ctx); err != nil {
			t.Fatal(err)
		}
		clock.Step(5*time.Minute + time.Second)
	}
	patches := 0
	for _, v := range verbs(dyn) {
		if v == "patch" {
			patches++
		}
	}
	if got := verbs(dyn); len(got) != 5 || patches != 1 {
		t.Errorf("calls %v: want 4 gets and 1 patch", got)
	}
	if caBundleOf(t, dyn) != string(m.CA()) {
		t.Error("the caBundle is not the served CA")
	}
}
