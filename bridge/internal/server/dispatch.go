package server

import (
	"fmt"
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/apiserver/pkg/endpoints/request"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/peer"
	"github.com/kalik1/hangar/bridge/internal/vmi"
)

// Forwarder sends a call to the bridge pod at host, on node.
type Forwarder interface {
	Forward(w http.ResponseWriter, r *http.Request, host, node string, caller user.Info)
}

// Dispatcher serves the subresource calls, once the server's filters have
// authenticated and authorized them: it finds the VMI's node, and serves
// the call there or forwards it to the bridge pod of that node.
type Dispatcher struct {
	// NodeName is this bridge pod's node.
	NodeName string
	Locator  vmi.Locator
	Peers    peer.Directory
	Forward  Forwarder
	// Handlers serve the subresources, by name. A subresource without one
	// answers 501.
	Handlers map[string]guest.Handler
}

func (d *Dispatcher) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	info, ok := request.RequestInfoFrom(ctx)
	if !ok {
		guest.WriteError(w, apierrors.NewInternalError(fmt.Errorf("no request info")))
		return
	}
	caller, ok := request.UserFrom(ctx)
	if !ok {
		guest.WriteError(w, apierrors.NewInternalError(fmt.Errorf("no user")))
		return
	}
	// .../namespaces/{ns}/virtualmachineinstances/{name}/{subresource}, and
	// nothing after it.
	if !info.IsResourceRequest || info.APIGroup != v1alpha1.GroupName || info.APIVersion != v1alpha1.Version ||
		info.Resource != v1alpha1.Resource || info.Namespace == "" || info.Name == "" || len(info.Parts) != 3 {
		guest.WriteError(w, notFound())
		return
	}
	sub, ok := v1alpha1.Lookup(info.Subresource)
	if !ok {
		guest.WriteError(w, notFound())
		return
	}
	if !sub.Allows(info.Verb) {
		guest.WriteError(w, apierrors.NewMethodNotSupported(
			schema.GroupResource{Group: v1alpha1.GroupName, Resource: v1alpha1.Resource + "/" + sub.Name}, info.Verb))
		return
	}
	if r.ContentLength > guest.MaxBodyBytes {
		guest.WriteError(w, apierrors.NewRequestEntityTooLargeError(
			fmt.Sprintf("the body is limited to %d bytes", guest.MaxBodyBytes)))
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, guest.MaxBodyBytes)
	}

	target, err := d.Locator.Locate(ctx, info.Namespace, info.Name)
	if err != nil {
		guest.WriteError(w, err)
		return
	}
	if target.Node == d.NodeName {
		h := d.Handlers[sub.Name]
		if h == nil {
			h = guest.NotImplemented(sub.Name)
		}
		h.ServeGuest(w, r, guest.Call{Target: target, Subresource: sub.Name, Verb: info.Verb, User: caller})
		return
	}
	if peer.IsForwarded(caller) {
		// The VMI moved between the two bridges' reads, during a migration.
		// A forwarded call is never forwarded again: the caller retries.
		err := apierrors.NewServiceUnavailable(fmt.Sprintf(
			"virtualmachineinstance %s now runs on node %s, not on %s; try again", target, target.Node, d.NodeName))
		err.ErrStatus.Details = &metav1.StatusDetails{RetryAfterSeconds: 1}
		w.Header().Set("Retry-After", "1")
		guest.WriteError(w, err)
		return
	}
	host, err := d.Peers.Lookup(target.Node)
	if err != nil {
		guest.WriteError(w, err)
		return
	}
	d.Forward.Forward(w, r, host, target.Node, caller)
}

func notFound() error {
	return &apierrors.StatusError{ErrStatus: metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    http.StatusNotFound,
		Reason:  metav1.StatusReasonNotFound,
		Message: "the server could not find the requested resource",
	}}
}
