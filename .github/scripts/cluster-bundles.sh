#!/usr/bin/env bash
# cluster-bundles.sh OUTDIR [BRIDGE_IMAGE]
#
# Writes Hangar's cluster objects as the three files each GitHub Release
# carries, for distributions that install them next to the plugin image of
# the same release (k4all v2.7.0 and later, as separate components):
#
#   hangar-cluster.yaml       the roles (distribution/rbac.yaml) and the
#                             delete protection
#                             (distribution/protection-policy.yaml): nothing
#                             privileged, nothing in hangar-system;
#   hangar-node-agent.yaml    the node agent (distribution/node-agent, built
#                             with kustomize: its scripts become a
#                             ConfigMap): namespace hangar-system, the
#                             privileged DaemonSet and the Role for host
#                             devices there;
#   hangar-guest-bridge.yaml  the guest bridge (distribution/guest-bridge,
#                             kustomize): namespace hangar-system, its
#                             DaemonSet, Service, APIService and RBAC.
#
# The two bundles in hangar-system share their Namespace object, and only
# it. BRIDGE_IMAGE (name:tag) replaces the bridge's image of
# distribution/guest-bridge: the release passes the image it pushed, so a
# release candidate's bundle runs the candidate's image.
#
# Needs kubectl (kustomize). src/distribution.test.ts checks that the three
# apply on their own and share only the Namespace.
set -euo pipefail

out=${1:?output directory}
bridge_image=${2:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
pinned=ghcr.io/kalik1/hangar-guest-bridge
mkdir -p "$out"

{
  echo "# Hangar's roles and delete protection, from distribution/rbac.yaml"
  echo "# and distribution/protection-policy.yaml (https://github.com/kalik1/hangar)."
  echo "---"
  cat "$root/distribution/rbac.yaml"
  echo "---"
  cat "$root/distribution/protection-policy.yaml"
} > "$out/hangar-cluster.yaml"

{
  echo "# Hangar's node agent, from distribution/node-agent (https://github.com/kalik1/hangar):"
  echo "# a privileged DaemonSet in hangar-system for host devices."
  kubectl kustomize "$root/distribution/node-agent"
} > "$out/hangar-node-agent.yaml"

bridge_dir=$root/distribution/guest-bridge
if [ -n "$bridge_image" ]; then
  name=${bridge_image%:*}
  tag=${bridge_image##*:}
  if [ "$name" = "$bridge_image" ] || [[ "$tag" == */* ]]; then
    echo "BRIDGE_IMAGE must be name:tag, not '$bridge_image'" >&2
    exit 1
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  cp -R "$bridge_dir/." "$tmp/"
  cat >> "$tmp/kustomization.yaml" <<EOF
images:
  - name: $pinned
    newName: $name
    newTag: "$tag"
EOF
  bridge_dir=$tmp
fi
{
  echo "# Hangar's guest bridge, from distribution/guest-bridge (https://github.com/kalik1/hangar):"
  echo "# the aggregated API subresources.hangar.magesgate.com, a DaemonSet in hangar-system."
  echo "# Remove the APIService v1alpha1.subresources.hangar.magesgate.com first."
  kubectl kustomize "$bridge_dir"
} > "$out/hangar-guest-bridge.yaml"

# The bridge bundle runs exactly one image: the pinned one, or BRIDGE_IMAGE.
images=$(grep -E '^ +image: ' "$out/hangar-guest-bridge.yaml" | awk '{print $2}' | sort -u)
want=${bridge_image:-$(grep -hoE "$pinned:[0-9][0-9A-Za-z.-]*" "$root/distribution/guest-bridge/guest-bridge.yaml" | sort -u)}
if [ "$images" != "$want" ]; then
  echo "hangar-guest-bridge.yaml runs '$images', want '$want'" >&2
  exit 1
fi

for f in hangar-cluster.yaml hangar-node-agent.yaml hangar-guest-bridge.yaml; do
  echo "$f: $(grep -c '^kind:' "$out/$f") objects"
done
echo "hangar-guest-bridge.yaml runs $images"
