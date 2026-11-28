package app_test

// The cluster bundle (distribution/guest-bridge) and the binary must agree
// on the names, the port and the paths the bridge uses: this test reads the
// bundle's YAML and checks them against the bridge's constants. The bundle's
// RBAC is exercised by the kind smoke test (.github/scripts/bridge-e2e.sh).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/kalik1/hangar/bridge/internal/app"
	"github.com/kalik1/hangar/bridge/internal/certs"
	"github.com/kalik1/hangar/bridge/internal/launcher"
	"github.com/kalik1/hangar/bridge/internal/peer"
)

const bundleDir = "../../../distribution/guest-bridge"

func bundleObjects(t *testing.T) map[string]*unstructured.Unstructured {
	t.Helper()
	out := map[string]*unstructured.Unstructured{}
	for _, file := range []string{"guest-bridge.yaml", "rbac.yaml"} {
		raw, err := os.ReadFile(filepath.Join(bundleDir, file))
		if err != nil {
			t.Fatal(err)
		}
		r := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(raw)))
		for {
			doc, err := r.Read()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			js, err := utilyaml.ToJSON(doc)
			if err != nil {
				t.Fatal(err)
			}
			if len(bytes.TrimSpace(js)) == 0 || string(bytes.TrimSpace(js)) == "null" {
				continue
			}
			u := &unstructured.Unstructured{}
			if err := u.UnmarshalJSON(js); err != nil {
				t.Fatal(err)
			}
			out[u.GetKind()+" "+u.GetNamespace()+"/"+u.GetName()] = u
		}
	}
	return out
}

func typed(t *testing.T, u *unstructured.Unstructured, into any) {
	t.Helper()
	js, err := u.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(js, into); err != nil {
		t.Fatal(err)
	}
}

func get(t *testing.T, objs map[string]*unstructured.Unstructured, key string) *unstructured.Unstructured {
	t.Helper()
	u, ok := objs[key]
	if !ok {
		t.Fatalf("the bundle has no %s", key)
	}
	return u
}

func TestTheBundleMatchesTheBridge(t *testing.T) {
	objs := bundleObjects(t)
	ns := app.DefaultNamespace

	get(t, objs, "ServiceAccount "+ns+"/"+app.ServiceAccountName)

	var svc corev1.Service
	typed(t, get(t, objs, "Service "+ns+"/"+app.ServiceName), &svc)

	as := get(t, objs, "APIService /"+app.APIServiceName)
	if _, found, _ := unstructured.NestedFieldNoCopy(as.Object, "spec", "caBundle"); found {
		t.Error("the APIService ships a caBundle: the bridge sets it")
	}
	svcRef, _, _ := unstructured.NestedMap(as.Object, "spec", "service")
	if svcRef["namespace"] != ns || svcRef["name"] != app.ServiceName {
		t.Errorf("the APIService points at %v", svcRef)
	}
	if len(svc.Spec.Ports) != 1 || svcRef["port"] != int64(svc.Spec.Ports[0].Port) {
		t.Errorf("the APIService's port %v is not the Service's %v", svcRef["port"], svc.Spec.Ports)
	}

	var ds appsv1.DaemonSet
	typed(t, get(t, objs, "DaemonSet "+ns+"/hangar-guest-bridge"), &ds)
	pod := ds.Spec.Template
	if pod.Spec.ServiceAccountName != app.ServiceAccountName {
		t.Errorf("serviceAccountName %q", pod.Spec.ServiceAccountName)
	}
	sel, err := labels.Parse(app.PodSelector)
	if err != nil {
		t.Fatal(err)
	}
	if !sel.Matches(labels.Set(pod.Labels)) {
		t.Errorf("the bridge finds its peers by %s; the pods have %v", app.PodSelector, pod.Labels)
	}
	if !labels.SelectorFromSet(svc.Spec.Selector).Matches(labels.Set(pod.Labels)) {
		t.Errorf("the Service selects %v; the pods have %v", svc.Spec.Selector, pod.Labels)
	}

	if len(pod.Spec.Containers) != 1 {
		t.Fatalf("%d containers", len(pod.Spec.Containers))
	}
	c := pod.Spec.Containers[0]
	var port *corev1.ContainerPort
	for i := range c.Ports {
		if c.Ports[i].Name == svc.Spec.Ports[0].TargetPort.String() {
			port = &c.Ports[i]
		}
	}
	if port == nil || port.ContainerPort != app.DefaultSecurePort {
		t.Errorf("the Service's target %q is not the container port %d: %v", svc.Spec.Ports[0].TargetPort.String(), app.DefaultSecurePort, c.Ports)
	}
	if len(c.Args) != 0 || len(c.Command) != 0 {
		t.Errorf("the bridge runs with its defaults; the bundle passes %v %v", c.Command, c.Args)
	}

	env := map[string]string{}
	for _, e := range c.Env {
		if e.ValueFrom != nil && e.ValueFrom.FieldRef != nil {
			env[e.Name] = e.ValueFrom.FieldRef.FieldPath
		}
	}
	for name, path := range map[string]string{"NODE_NAME": "spec.nodeName", "POD_NAME": "metadata.name", "POD_NAMESPACE": "metadata.namespace"} {
		if env[name] != path {
			t.Errorf("env %s is %q, want the downward API's %s", name, env[name], path)
		}
	}

	// The projected token: its file is the bridge's default, its audience
	// the one the peers check.
	var tokenVolume string
	for _, m := range c.VolumeMounts {
		if strings.HasPrefix(app.DefaultPeerTokenFile, m.MountPath+"/") {
			tokenVolume = m.Name
			if !m.ReadOnly {
				t.Error("the token is mounted writable")
			}
		}
	}
	found := false
	for _, v := range pod.Spec.Volumes {
		if v.Name != tokenVolume || v.Projected == nil {
			continue
		}
		for _, s := range v.Projected.Sources {
			if st := s.ServiceAccountToken; st != nil && st.Audience == peer.Audience && filepath.Base(app.DefaultPeerTokenFile) == st.Path {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("no projected token of audience %s at %s", peer.Audience, app.DefaultPeerTokenFile)
	}

	// The kubelet's pods directory, where the dialer looks for the
	// launchers: the host's, read-only, at the same path, without mount
	// propagation.
	var pods *corev1.VolumeMount
	for i := range c.VolumeMounts {
		if c.VolumeMounts[i].MountPath == launcher.DefaultPodsDir {
			pods = &c.VolumeMounts[i]
		}
	}
	if pods == nil {
		t.Fatalf("nothing is mounted at %s", launcher.DefaultPodsDir)
	}
	if !pods.ReadOnly || pods.MountPropagation != nil {
		t.Errorf("%s: readOnly %v, mountPropagation %v", launcher.DefaultPodsDir, pods.ReadOnly, pods.MountPropagation)
	}
	for _, v := range pod.Spec.Volumes {
		if v.Name == pods.Name && (v.HostPath == nil || v.HostPath.Path != launcher.DefaultPodsDir) {
			t.Errorf("%s is not the host's: %+v", launcher.DefaultPodsDir, v.VolumeSource)
		}
	}

	// The RBAC names the bridge's own objects.
	if !strings.Contains(rulesOf(t, objs, "Role "+ns+"/hangar-guest-bridge"), "secrets get,update "+app.SecretName) {
		t.Errorf("the Role does not give get and update on the Secret %s", app.SecretName)
	}
	if !strings.Contains(rulesOf(t, objs, "Role "+ns+"/hangar-guest-bridge"), "leases get,update "+app.LeaseName) {
		t.Errorf("the Role does not give get and update on the Lease %s", app.LeaseName)
	}
	if !strings.Contains(rulesOf(t, objs, "ClusterRole /hangar-guest-bridge"), "apiservices get,patch "+app.APIServiceName) {
		t.Errorf("the ClusterRole does not give get and patch on the APIService %s", app.APIServiceName)
	}
	if certs.APIServiceGVR.Group != "apiregistration.k8s.io" {
		t.Errorf("APIServiceGVR %v", certs.APIServiceGVR)
	}
}

// rulesOf lists a role's rules as "resource verbs resourceNames" lines.
func rulesOf(t *testing.T, objs map[string]*unstructured.Unstructured, key string) string {
	t.Helper()
	rules, _, _ := unstructured.NestedSlice(get(t, objs, key).Object, "rules")
	var lines []string
	for _, r := range rules {
		m := r.(map[string]any)
		str := func(k string) string {
			var s []string
			if l, ok := m[k].([]any); ok {
				for _, x := range l {
					s = append(s, x.(string))
				}
			}
			return strings.Join(s, ",")
		}
		lines = append(lines, str("resources")+" "+str("verbs")+" "+str("resourceNames"))
	}
	return strings.Join(lines, "\n")
}
