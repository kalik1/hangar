#!/usr/bin/env bash
# bridge-e2e.sh IMAGE
#
# Smoke test of the guest bridge's cluster bundle on a two-node kind
# cluster, with IMAGE, a local build of Containerfile.bridge. There is no
# KubeVirt: a stub of its VMI CRD stands in. It checks that:
#
#   - the three bundles apply, the bridge's first;
#   - a bridge pod gets ready on each node, the control plane's included,
#     sets the APIService's caBundle, and the APIService becomes Available;
#   - discovery lists the two subresources, and stays complete;
#   - the API server refuses a user without a role (403); a hangar-viewer
#     reaches the bridge for guestinfo, not for guestfiles; a
#     hangar-guest-admin reaches it for guestfiles;
#   - calls for VMIs on either node never fail in the forwarding between
#     bridge pods;
#   - applying the bundle again, client-side or server-side, keeps the
#     caBundle;
#   - removing the bridge, APIService first, leaves discovery clean and
#     hangar-system in place for the node agent.
#
# Needs kind, kubectl, jq and docker (CONTAINER_TOOL=podman with
# KIND_EXPERIMENTAL_PROVIDER=podman works too). KIND_NODE_IMAGE picks the
# node image, KEEP_CLUSTER=1 keeps the cluster afterwards.
set -euo pipefail

image=${1:?image, e.g. localhost/hangar-guest-bridge:e2e}
root=$(cd "$(dirname "$0")/../.." && pwd)
cluster=${KIND_CLUSTER:-hangar-bridge-e2e}
node_image=${KIND_NODE_IMAGE:-kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed}
tool=${CONTAINER_TOOL:-docker}
apiservice=v1alpha1.subresources.hangar.magesgate.com
group=/apis/subresources.hangar.magesgate.com/v1alpha1
vms=e2e-vms
work=$(mktemp -d)
ctx=kind-$cluster
k() { kubectl --context "$ctx" "$@"; }

step() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "== $*"; fi; }
endstep() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }
fail() { echo "FAIL: $*" >&2; exit 1; }

diagnostics() {
  echo "== diagnostics"
  k get nodes -o wide || true
  k -n hangar-system get all,secrets,leases -o wide || true
  k get apiservice "$apiservice" -o yaml || true
  k -n hangar-system describe daemonset hangar-guest-bridge || true
  k -n hangar-system logs -l app.kubernetes.io/name=hangar-guest-bridge --all-containers --prefix --tail=200 || true
  k get events -A --sort-by=.lastTimestamp | tail -40 || true
}

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then diagnostics; fi
  if [ "${KEEP_CLUSTER:-}" != 1 ]; then kind delete cluster --name "$cluster" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT

# call USER PATH: prints the answer, or kubectl's "Error from server (Reason): …"
# line, and never fails.
call() {
  local who=$1 path=$2
  k get --raw "$path" --as="$who" 2>&1 || true
}

expect() {
  local what=$1 got=$2 want=$3
  case "$got" in
    *"$want"*) echo "ok: $what" ;;
    *) fail "$what: got '$got', want '$want'" ;;
  esac
}

step "kind cluster $cluster ($node_image)"
cat > "$work/kind.yaml" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
EOF
kind create cluster --name "$cluster" --image "$node_image" --config "$work/kind.yaml" --wait 120s
"$tool" save "$image" -o "$work/image.tar"
kind load image-archive "$work/image.tar" --name "$cluster"
endstep

step "the bundles, with $image"
"$root/.github/scripts/cluster-bundles.sh" "$work/bundles" "$image"
# What KubeVirt would bring: its VMI CRD (a stub) and its namespace, where
# hangar-cluster.yaml has a Role.
k apply -f - <<'EOF'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: virtualmachineinstances.kubevirt.io
spec:
  group: kubevirt.io
  scope: Namespaced
  names: {plural: virtualmachineinstances, singular: virtualmachineinstance, kind: VirtualMachineInstance, shortNames: [vmi]}
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema: {type: object, x-kubernetes-preserve-unknown-fields: true}
---
apiVersion: v1
kind: Namespace
metadata:
  name: kubevirt
EOF
k wait --for=condition=Established crd/virtualmachineinstances.kubevirt.io --timeout=60s
k apply -f "$work/bundles/hangar-guest-bridge.yaml"
k apply -f "$work/bundles/hangar-node-agent.yaml"
k apply -f "$work/bundles/hangar-cluster.yaml"
endstep

step "the bridge gets ready and Available"
k -n hangar-system rollout status daemonset/hangar-guest-bridge --timeout=180s
ready=$(k -n hangar-system get daemonset hangar-guest-bridge -o jsonpath='{.status.numberReady}')
[ "$ready" = 2 ] || fail "$ready bridge pods ready, want 2 (one per node)"
k wait --for=condition=Available "apiservice/$apiservice" --timeout=120s
ca=$(k get apiservice "$apiservice" -o jsonpath='{.spec.caBundle}' | base64 -d)
secret_ca=$(k -n hangar-system get secret hangar-guest-bridge-tls -o jsonpath='{.data.ca\.crt}' | base64 -d)
[ -n "$ca" ] && [ "$ca" = "$secret_ca" ] || fail "the caBundle is not the CA of the Secret hangar-guest-bridge-tls"
echo "ok: caBundle set to the bridge's CA"
endstep

step "discovery"
k get --raw "$group" | jq -e '[.resources[] | "\(.name) \(.verbs | join(","))"] == ["virtualmachineinstances/guestinfo get", "virtualmachineinstances/guestfiles get,create,update,delete"]' >/dev/null \
  || fail "discovery of $group: $(k get --raw "$group")"
k get --raw /apis | jq -e '.groups[] | select(.name == "subresources.hangar.magesgate.com")' >/dev/null || fail "/apis does not list the group"
k api-resources >/dev/null 2>"$work/discovery.err" || fail "discovery: $(cat "$work/discovery.err")"
echo "ok: the two subresources, and complete discovery"
endstep

step "authorization"
k create namespace "$vms"
k -n "$vms" create rolebinding e2e-viewer --clusterrole=hangar-viewer --user=e2e-viewer
k -n "$vms" create rolebinding e2e-guest-admin --clusterrole=hangar-guest-admin --user=e2e-guest-admin
missing="virtualmachineinstances.kubevirt.io \"missing\" not found"
expect "no role: guestinfo is forbidden" "$(call e2e-nobody "$group/namespaces/$vms/virtualmachineinstances/missing/guestinfo")" "(Forbidden)"
expect "hangar-viewer: guestinfo reaches the bridge" "$(call e2e-viewer "$group/namespaces/$vms/virtualmachineinstances/missing/guestinfo")" "$missing"
expect "hangar-viewer: guestfiles is forbidden" "$(call e2e-viewer "$group/namespaces/$vms/virtualmachineinstances/missing/guestfiles?op=stat&path=/")" "(Forbidden)"
expect "hangar-guest-admin: guestfiles reaches the bridge" "$(call e2e-guest-admin "$group/namespaces/$vms/virtualmachineinstances/missing/guestfiles?op=stat&path=/")" "$missing"
expect "hangar-guest-admin: guestinfo is forbidden" "$(call e2e-guest-admin "$group/namespaces/$vms/virtualmachineinstances/missing/guestinfo")" "(Forbidden)"
endstep

step "calls for VMIs on both nodes"
# Running VMIs, as KubeVirt reports them, one per node (no launcher: what
# the bridge then answers is its handlers' business). The Service spreads
# the calls over both bridge pods, so some are forwarded.
for node in $(k get nodes -o jsonpath='{.items[*].metadata.name}'); do
  k -n "$vms" apply -f - <<EOF
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
metadata:
  name: vm-$node
status:
  phase: Running
  nodeName: $node
  activePods:
    00000000-0000-0000-0000-$(printf '%s' "$node" | sha256sum | cut -c1-12): $node
EOF
  for _ in 1 2 3 4 5 6; do
    out=$(call e2e-viewer "$group/namespaces/$vms/virtualmachineinstances/vm-$node/guestinfo")
    case "$out" in
      *"(Unauthorized)"* | *"(Forbidden)"* | *"the guest bridge on node"* | *"peer token"* | *"could not find the requested resource"*)
        fail "guestinfo of vm-$node: $out" ;;
    esac
  done
  echo "ok: vm-$node: $(printf '%s' "$out" | head -c 160)"
done
endstep

step "applying the bundle again keeps the caBundle"
k apply -f "$work/bundles/hangar-guest-bridge.yaml"
k apply --server-side --force-conflicts --field-manager=e2e-distribution -f "$work/bundles/hangar-guest-bridge.yaml"
[ "$(k get apiservice "$apiservice" -o jsonpath='{.spec.caBundle}' | base64 -d)" = "$secret_ca" ] || fail "a new apply dropped the caBundle"
k wait --for=condition=Available "apiservice/$apiservice" --timeout=30s
echo "ok: caBundle kept"
endstep

step "removal, APIService first"
k delete apiservice "$apiservice" --wait
# As README.md says: every object of the bridge but the shared Namespace
# carries its name label.
k delete -k "$root/distribution/guest-bridge" -l app.kubernetes.io/name=hangar-guest-bridge --wait --timeout=120s
k -n hangar-system wait --for=delete pod -l app.kubernetes.io/name=hangar-guest-bridge --timeout=120s
# What the bridge created itself.
k -n hangar-system delete secret hangar-guest-bridge-tls --ignore-not-found
k -n hangar-system delete lease hangar-guest-bridge --ignore-not-found
k api-resources >/dev/null 2>"$work/discovery.err" || fail "discovery after removal: $(cat "$work/discovery.err")"
if k get --raw /apis | jq -e '.groups[] | select(.name == "subresources.hangar.magesgate.com")' >/dev/null; then
  fail "/apis still lists the group"
fi
k get namespace hangar-system >/dev/null || fail "hangar-system is gone"
k -n hangar-system get daemonset hangar-node-agent >/dev/null || fail "the node agent is gone"
left=$(k -n hangar-system get all,serviceaccounts,roles,rolebindings,secrets,leases -l app.kubernetes.io/name=hangar-guest-bridge -o name)
[ -z "$left" ] || fail "left in hangar-system: $left"
echo "ok: discovery clean, hangar-system and the node agent in place"
endstep

echo "PASS: the guest bridge bundle on kind"
