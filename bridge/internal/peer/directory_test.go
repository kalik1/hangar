package peer

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	corelisters "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"
)

func bridgePod(name, node, ip string, ready bool, created time.Time, mutate ...func(*corev1.Pod)) *corev1.Pod {
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: "hangar-system",
			Labels:            map[string]string{"app.kubernetes.io/name": "hangar-guest-bridge"},
			CreationTimestamp: metav1.NewTime(created),
		},
		Spec: corev1.PodSpec{NodeName: node},
		Status: corev1.PodStatus{
			Phase:      corev1.PodRunning,
			PodIP:      ip,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: status}},
		},
	}
	for _, m := range mutate {
		m(p)
	}
	return p
}

func directoryOf(t *testing.T, pods ...*corev1.Pod) Directory {
	t.Helper()
	indexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	for _, p := range pods {
		if err := indexer.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	selector, err := labels.Parse("app.kubernetes.io/name=hangar-guest-bridge")
	if err != nil {
		t.Fatal(err)
	}
	return NewDirectory(corelisters.NewPodLister(indexer).Pods("hangar-system"), selector)
}

func TestDirectoryLookup(t *testing.T) {
	t0 := time.Date(2026, 11, 28, 0, 0, 0, 0, time.UTC)
	d := directoryOf(t,
		bridgePod("a", "node-a", "192.0.2.1", true, t0),
		// Rolling update on node-b: the old pod is terminating, the new one
		// is ready, and an even newer one is not ready yet.
		bridgePod("b-old", "node-b", "192.0.2.2", true, t0, func(p *corev1.Pod) { now := metav1.Now(); p.DeletionTimestamp = &now }),
		bridgePod("b-new", "node-b", "192.0.2.3", true, t0.Add(time.Minute)),
		bridgePod("b-newest", "node-b", "192.0.2.4", false, t0.Add(2*time.Minute)),
		// Two ready pods on node-c: the newest.
		bridgePod("c-1", "node-c", "192.0.2.5", true, t0),
		bridgePod("c-2", "node-c", "192.0.2.6", true, t0.Add(time.Minute)),
		bridgePod("d", "node-d", "", true, t0),
		bridgePod("e", "node-e", "192.0.2.7", true, t0, func(p *corev1.Pod) { p.Status.Phase = corev1.PodPending }),
		bridgePod("f", "node-f", "192.0.2.8", true, t0, func(p *corev1.Pod) { p.Labels = map[string]string{"app": "other"} }),
		bridgePod("g", "node-g", "192.0.2.9", true, t0, func(p *corev1.Pod) { p.Status.Conditions = nil }),
	)
	want := map[string]string{"node-a": "192.0.2.1", "node-b": "192.0.2.3", "node-c": "192.0.2.6"}
	for node, ip := range want {
		got, err := d.Lookup(node)
		if err != nil || got != ip {
			t.Errorf("%s: %q, %v; want %q", node, got, err, ip)
		}
	}
	for _, node := range []string{"node-d", "node-e", "node-f", "node-g", "node-z"} {
		if _, err := d.Lookup(node); !apierrors.IsServiceUnavailable(err) {
			t.Errorf("%s: err %v, want ServiceUnavailable", node, err)
		}
	}
}
