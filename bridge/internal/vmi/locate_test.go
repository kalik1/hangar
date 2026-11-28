package vmi

import (
	"context"
	"net/http"
	"slices"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func vmiObject(name string, status map[string]any) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "kubevirt.io/v1",
		"kind":       "VirtualMachineInstance",
		"metadata":   map[string]any{"name": name, "namespace": "vms", "uid": "uid-" + name},
	}}
	if status != nil {
		u.Object["status"] = status
	}
	return u
}

func TestTargetOf(t *testing.T) {
	cases := []struct {
		name     string
		status   map[string]any
		wantNode string
		wantPods []types.UID
		conflict bool
	}{
		{
			name:     "running",
			status:   map[string]any{"phase": "Running", "nodeName": "node-a", "activePods": map[string]any{"pod-1": "node-a"}},
			wantNode: "node-a", wantPods: []types.UID{"pod-1"},
		},
		{
			name:     "migrating: the source node until it completes",
			status:   map[string]any{"phase": "Running", "nodeName": "node-a", "activePods": map[string]any{"pod-1": "node-a", "pod-2": "node-b"}},
			wantNode: "node-a", wantPods: []types.UID{"pod-1"},
		},
		{
			name:     "migrated: the target node, the source pod still listed",
			status:   map[string]any{"phase": "Running", "nodeName": "node-b", "activePods": map[string]any{"pod-1": "node-a", "pod-2": "node-b"}},
			wantNode: "node-b", wantPods: []types.UID{"pod-2"},
		},
		{
			name:     "no nodeName yet, one node in activePods",
			status:   map[string]any{"phase": "Scheduled", "activePods": map[string]any{"pod-2": "node-c", "pod-1": "node-c"}},
			wantNode: "node-c", wantPods: []types.UID{"pod-1", "pod-2"},
		},
		{
			name:     "no nodeName, pods on two nodes",
			status:   map[string]any{"phase": "Scheduled", "activePods": map[string]any{"pod-1": "node-a", "pod-2": "node-b"}},
			conflict: true,
		},
		{name: "pending", status: map[string]any{"phase": "Pending"}, conflict: true},
		{name: "no status", conflict: true},
		{
			name:     "succeeded",
			status:   map[string]any{"phase": "Succeeded", "nodeName": "node-a", "activePods": map[string]any{"pod-1": "node-a"}},
			conflict: true,
		},
		{
			name:     "failed",
			status:   map[string]any{"phase": "Failed", "nodeName": "node-a", "activePods": map[string]any{"pod-1": "node-a"}},
			conflict: true,
		},
		{
			name:     "nodeName without an active pod there",
			status:   map[string]any{"phase": "Running", "nodeName": "node-a", "activePods": map[string]any{"pod-2": "node-b"}},
			conflict: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := TargetOf(vmiObject("vm", tc.status))
			if tc.conflict {
				if !apierrors.IsConflict(err) {
					t.Fatalf("err = %v, want a Conflict", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Node != tc.wantNode || !slices.Equal(got.Pods, tc.wantPods) {
				t.Errorf("node %q pods %v, want %q %v", got.Node, got.Pods, tc.wantNode, tc.wantPods)
			}
			if got.Namespace != "vms" || got.Name != "vm" || got.UID != "uid-vm" {
				t.Errorf("identity %+v", got)
			}
		})
	}
}

func TestTargetOfBadActivePods(t *testing.T) {
	_, err := TargetOf(vmiObject("vm", map[string]any{"phase": "Running", "activePods": "nope"}))
	if apierrors.ReasonForError(err) != "InternalError" {
		t.Fatalf("err = %v", err)
	}
}

func TestLocate(t *testing.T) {
	scheme := runtime.NewScheme()
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{GVR: "VirtualMachineInstanceList"},
		vmiObject("up", map[string]any{"phase": "Running", "nodeName": "node-a", "activePods": map[string]any{"p": "node-a"}}))
	l := NewLocator(client)

	got, err := l.Locate(context.Background(), "vms", "up")
	if err != nil || got.Node != "node-a" {
		t.Fatalf("Locate = %+v, %v", got, err)
	}
	_, err = l.Locate(context.Background(), "vms", "missing")
	if !apierrors.IsNotFound(err) {
		t.Fatalf("missing VMI: %v", err)
	}
	if s := err.(apierrors.APIStatus).Status(); s.Code != http.StatusNotFound || s.Details.Group != "kubevirt.io" {
		t.Errorf("status %+v", s)
	}
}
