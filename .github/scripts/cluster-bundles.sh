#!/usr/bin/env bash
# cluster-bundles.sh OUTDIR
#
# Writes Hangar's cluster objects as the two files each GitHub Release
# carries, for distributions that install them next to the plugin image of
# the same release (k4all v2.7.0 and later, as two components):
#
#   hangar-cluster.yaml     the roles (distribution/rbac.yaml) and the delete
#                           protection (distribution/protection-policy.yaml):
#                           nothing privileged, nothing in hangar-system;
#   hangar-node-agent.yaml  the node agent (distribution/node-agent, built
#                           with kustomize: its scripts become a ConfigMap):
#                           namespace hangar-system, the privileged
#                           DaemonSet and the Role for host devices there.
#
# Needs kubectl (kustomize). src/distribution.test.ts checks that the two
# apply on their own and share no object.
set -euo pipefail

out=${1:?output directory}
root=$(cd "$(dirname "$0")/../.." && pwd)
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

for f in hangar-cluster.yaml hangar-node-agent.yaml; do
  echo "$f: $(grep -c '^kind:' "$out/$f") objects"
done
