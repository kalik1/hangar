// Package v1alpha1 is the guest bridge's API: the group version
// subresources.hangar.magesgate.com/v1alpha1.
//
// The group serves subresources of KubeVirt's virtualmachineinstances only,
// as subresources.kubevirt.io does: the parent kind stays KubeVirt's, and
// discovery lists no parent resource. Calls go to
//
//	/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/{ns}/virtualmachineinstances/{name}/{subresource}
//
// and the HTTP method decides the RBAC verb: GET get, POST create, PUT
// update, DELETE delete.
package v1alpha1

import (
	"slices"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	// GroupName is the API group of the guest bridge.
	GroupName = "subresources.hangar.magesgate.com"
	// Version is the only version of the group.
	Version = "v1alpha1"

	// Resource is the parent resource of every subresource: KubeVirt's VMIs.
	Resource = "virtualmachineinstances"

	// SubresourceGuestInfo is the read-only subresource with what the guest
	// agent reports. Its answer is a GuestInfo.
	SubresourceGuestInfo = "guestinfo"
	// SubresourceGuestFiles is the subresource of file operations in the
	// guest.
	SubresourceGuestFiles = "guestfiles"
)

// SchemeGroupVersion is the group version of the guest bridge's API.
var SchemeGroupVersion = schema.GroupVersion{Group: GroupName, Version: Version}

// Subresource is one subresource of virtualmachineinstances in this group.
type Subresource struct {
	// Name is the subresource's name, such as "guestinfo".
	Name string
	// Kind is the kind of its answer, such as "GuestInfo".
	Kind string
	// Verbs are the RBAC verbs it accepts. A call with another verb is
	// refused with 405 before it reaches the subresource's handler.
	Verbs []string
}

// Allows reports whether the subresource accepts the RBAC verb.
func (s Subresource) Allows(verb string) bool {
	return slices.Contains(s.Verbs, verb)
}

// Subresources is the approved API: what discovery lists and what the bridge
// serves. Its order is discovery's order.
var Subresources = []Subresource{
	{Name: SubresourceGuestInfo, Kind: "GuestInfo", Verbs: []string{"get"}},
	{Name: SubresourceGuestFiles, Kind: "GuestFiles", Verbs: []string{"get", "create", "update", "delete"}},
}

// Lookup returns the subresource with the given name.
func Lookup(name string) (Subresource, bool) {
	for _, s := range Subresources {
		if s.Name == name {
			return s, true
		}
	}
	return Subresource{}, false
}

// APIResources returns the group version's resources as legacy discovery
// lists them: "virtualmachineinstances/<subresource>", namespaced, with the
// answer's kind and the verbs.
func APIResources() []metav1.APIResource {
	out := make([]metav1.APIResource, 0, len(Subresources))
	for _, s := range Subresources {
		out = append(out, metav1.APIResource{
			Name:       Resource + "/" + s.Name,
			Namespaced: true,
			Kind:       s.Kind,
			Verbs:      slices.Clone(s.Verbs),
		})
	}
	return out
}

// APIGroup returns the group as discovery lists it.
func APIGroup() metav1.APIGroup {
	gv := metav1.GroupVersionForDiscovery{GroupVersion: SchemeGroupVersion.String(), Version: Version}
	return metav1.APIGroup{
		Name:             GroupName,
		Versions:         []metav1.GroupVersionForDiscovery{gv},
		PreferredVersion: gv,
	}
}
