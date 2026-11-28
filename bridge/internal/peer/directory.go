package peer

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/labels"
	corelisters "k8s.io/client-go/listers/core/v1"
)

// Directory finds the bridge pod of a node.
type Directory interface {
	// Lookup returns the pod IP of a ready bridge pod on the node. No such
	// pod is a ServiceUnavailable API error.
	Lookup(node string) (string, error)
}

// NewDirectory returns a Directory over a lister of the bridge's pods: the
// pods of its namespace that match selector.
func NewDirectory(pods corelisters.PodNamespaceLister, selector labels.Selector) Directory {
	return &podDirectory{pods: pods, selector: selector}
}

type podDirectory struct {
	pods     corelisters.PodNamespaceLister
	selector labels.Selector
}

func (d *podDirectory) Lookup(node string) (string, error) {
	pods, err := d.pods.List(d.selector)
	if err != nil {
		return "", apierrors.NewInternalError(fmt.Errorf("listing the guest bridge's pods: %w", err))
	}
	var best *corev1.Pod
	for _, p := range pods {
		if p.Spec.NodeName != node || !serving(p) {
			continue
		}
		// During a rolling update, the newest pod.
		if best == nil || p.CreationTimestamp.After(best.CreationTimestamp.Time) {
			best = p
		}
	}
	if best == nil {
		return "", apierrors.NewServiceUnavailable(fmt.Sprintf("no guest bridge is ready on node %s", node))
	}
	return best.Status.PodIP, nil
}

// serving reports whether the pod is ready and not shutting down.
func serving(p *corev1.Pod) bool {
	if p.DeletionTimestamp != nil || p.Status.PodIP == "" || p.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}
