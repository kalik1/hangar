// Package vmi finds the node a KubeVirt VMI runs on.
package vmi

import (
	"context"
	"fmt"
	"slices"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"github.com/kalik1/hangar/bridge/internal/guest"
)

// GroupResource is KubeVirt's VMI resource, for errors.
var GroupResource = schema.GroupResource{Group: "kubevirt.io", Resource: "virtualmachineinstances"}

// GVR is the version of KubeVirt's VMI API the bridge reads.
var GVR = GroupResource.WithVersion("v1")

// Locator resolves a VMI into the Target of a call.
type Locator interface {
	// Locate returns the VMI's Target. A missing VMI is a NotFound API
	// error; a VMI that runs on no node is a Conflict.
	Locate(ctx context.Context, namespace, name string) (guest.Target, error)
}

// NewLocator returns a Locator that reads each VMI from the API server.
//
// It reads on every call instead of from a cache, so that a call made right
// after a live migration goes to the VMI's new node.
func NewLocator(client dynamic.Interface) Locator {
	return &apiLocator{client: client}
}

type apiLocator struct {
	client dynamic.Interface
}

func (l *apiLocator) Locate(ctx context.Context, namespace, name string) (guest.Target, error) {
	obj, err := l.client.Resource(GVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return guest.Target{}, apierrors.NewNotFound(GroupResource, name)
		}
		return guest.Target{}, apierrors.NewInternalError(fmt.Errorf("reading virtualmachineinstance %s/%s: %w", namespace, name, err))
	}
	return TargetOf(obj)
}

// TargetOf resolves a VMI object into a Target.
//
// The node is status.nodeName, which KubeVirt moves to the target node when
// a migration completes; the pods are the status.activePods entries on that
// node. A VMI without status.nodeName whose active pods are all on one node
// is on that node. A VMI in a final phase, or on no node, is a Conflict.
func TargetOf(obj *unstructured.Unstructured) (guest.Target, error) {
	t := guest.Target{
		Namespace: obj.GetNamespace(),
		Name:      obj.GetName(),
		UID:       obj.GetUID(),
	}
	t.Phase, _, _ = unstructured.NestedString(obj.Object, "status", "phase")
	switch t.Phase {
	case "Succeeded", "Failed":
		return guest.Target{}, notRunning(t, "it has stopped")
	}

	active, _, err := unstructured.NestedStringMap(obj.Object, "status", "activePods")
	if err != nil {
		return guest.Target{}, apierrors.NewInternalError(fmt.Errorf("virtualmachineinstance %s: status.activePods: %w", t, err))
	}
	nodeName, _, _ := unstructured.NestedString(obj.Object, "status", "nodeName")

	t.Node = nodeName
	if t.Node == "" {
		for _, node := range active {
			switch {
			case t.Node == "":
				t.Node = node
			case t.Node != node:
				return guest.Target{}, notRunning(t, "its pods are on several nodes and it names none")
			}
		}
	}
	if t.Node == "" {
		return guest.Target{}, notRunning(t, "it runs on no node")
	}
	for uid, node := range active {
		if node == t.Node {
			t.Pods = append(t.Pods, types.UID(uid))
		}
	}
	if len(t.Pods) == 0 {
		return guest.Target{}, notRunning(t, fmt.Sprintf("it has no active pod on its node %s", t.Node))
	}
	slices.Sort(t.Pods)
	return t, nil
}

func notRunning(t guest.Target, why string) error {
	phase := t.Phase
	if phase == "" {
		phase = "unknown"
	}
	return apierrors.NewConflict(GroupResource, t.Name,
		fmt.Errorf("the virtual machine is not running (phase %s): %s", phase, why))
}
