// Package guest is the seam between the bridge's API server and the code that
// talks to a VM's guest agent.
//
// The server authenticates and authorizes each call, finds the node the VMI
// runs on, and forwards the call to the bridge on that node when it is not
// its own. A Handler is called only on the bridge of the VMI's node, with the
// VMI resolved into a Target, and only with a verb its subresource accepts
// (see v1alpha1.Subresources). It builds every guest command itself from
// typed parameters.
package guest

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apiserver/pkg/authentication/user"
)

// MaxBodyBytes caps every request body before a handler or a peer bridge sees
// it. The largest body of the API is a guestfiles write of 1 MiB.
const MaxBodyBytes = 1 << 20

// Target is the VMI a call is for, on the node that serves it.
type Target struct {
	Namespace string
	Name      string
	UID       types.UID
	// Phase is the VMI's status.phase, such as "Running".
	Phase string
	// Node is the node the VMI runs on. A Handler always runs on it.
	Node string
	// Pods are the UIDs of the VMI's virt-launcher pods on Node, from
	// status.activePods, sorted. There is one, except around a migration.
	Pods []types.UID
}

// String returns "namespace/name".
func (t Target) String() string { return t.Namespace + "/" + t.Name }

// Call is one authenticated and authorized call to a subresource.
type Call struct {
	Target Target
	// Subresource is the subresource's name, such as "guestinfo".
	Subresource string
	// Verb is the RBAC verb the call was authorized for: get, create, update
	// or delete.
	Verb string
	// User is the caller, as the API server authenticated it (or as the
	// bridge that forwarded the call passed it on).
	User user.Info
}

// Handler serves one subresource for the VMIs of this bridge's node.
//
// The request's body is capped at MaxBodyBytes; its context ends when the
// caller goes away or the API server's request timeout (60 s) passes.
type Handler interface {
	ServeGuest(w http.ResponseWriter, r *http.Request, call Call)
}

// HandlerFunc adapts a function to Handler.
type HandlerFunc func(w http.ResponseWriter, r *http.Request, call Call)

// ServeGuest calls f.
func (f HandlerFunc) ServeGuest(w http.ResponseWriter, r *http.Request, call Call) {
	f(w, r, call)
}

// NotImplemented is the handler of a subresource this build does not serve.
func NotImplemented(subresource string) Handler {
	return HandlerFunc(func(w http.ResponseWriter, _ *http.Request, _ Call) {
		WriteError(w, &apierrors.StatusError{ErrStatus: metav1.Status{
			Status:  metav1.StatusFailure,
			Code:    http.StatusNotImplemented,
			Reason:  "NotImplemented",
			Message: fmt.Sprintf("this guest bridge does not serve %s yet", subresource),
		}})
	})
}

// WriteObject writes obj as JSON with the given status code.
func WriteObject(w http.ResponseWriter, code int, obj any) {
	body, err := json.Marshal(obj)
	if err != nil {
		WriteError(w, apierrors.NewInternalError(err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

// WriteError writes err as a metav1.Status, as the Kubernetes API does. An
// error that is not an API status becomes a 500 InternalError.
func WriteError(w http.ResponseWriter, err error) {
	status := ErrorStatus(err)
	WriteObject(w, int(status.Code), status)
}

// ErrorStatus returns err as a metav1.Status with its kind and version set.
func ErrorStatus(err error) *metav1.Status {
	var apiStatus apierrors.APIStatus
	var status metav1.Status
	if errors.As(err, &apiStatus) {
		status = apiStatus.Status()
	} else {
		status = apierrors.NewInternalError(err).ErrStatus
	}
	if status.Code == 0 {
		status.Code = http.StatusInternalServerError
	}
	status.Kind = "Status"
	status.APIVersion = "v1"
	return &status
}
