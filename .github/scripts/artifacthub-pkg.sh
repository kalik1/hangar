#!/usr/bin/env bash
# artifacthub-pkg.sh VERSION TARBALL OUTDIR
#
# Writes OUTDIR/artifacthub-pkg.yml, the Artifact Hub metadata of the
# Headlamp plugin release VERSION whose `headlamp-plugin package` tarball is
# TARBALL (uploaded to the GitHub Release of tag vVERSION). Headlamp's plugin
# manager downloads the archive URL, checks the SHA256 and installs the
# plugin into a folder named after `name`.
set -euo pipefail

NAME=hangar-headlamp-plugin
DISPLAY_NAME="Hangar"
DESCRIPTION="A virtualization console for KubeVirt and CDI: VMs and their consoles, hosts, datastores, networks, images and templates."
KEYWORDS="kubevirt, cdi, virtualization, virtual machines, kubernetes"
# Headlamp versions the plugin is built for (@kinvolk/headlamp-plugin 0.14.0).
VERSION_COMPAT=">=0.46"
# Where it was tested: in-cluster and web (desktop not yet).
DISTRO_COMPAT="in-cluster,web"

version=${1:?version}
tarball=${2:?tarball}
out=${3:?output directory}
repo=${GITHUB_REPOSITORY:-kalik1/hangar}
owner=${repo%%/*}

[ -s "$tarball" ] || { echo "no tarball at $tarball" >&2; exit 1; }
sum=$(sha256sum "$tarball" | cut -d' ' -f1)
mkdir -p "$out"
cat > "$out/artifacthub-pkg.yml" <<YAML
version: ${version}
name: ${NAME}
displayName: "${DISPLAY_NAME}"
createdAt: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
description: "${DESCRIPTION}"
license: GPL-3.0-only
homeURL: https://github.com/${repo}
keywords: [${KEYWORDS}]
links:
  - name: Source
    url: https://github.com/${repo}
  - name: Image (initContainer)
    url: https://github.com/${repo}/pkgs/container/${NAME}
annotations:
  headlamp/plugin/archive-url: "https://github.com/${repo}/releases/download/v${version}/$(basename "$tarball")"
  headlamp/plugin/archive-checksum: "SHA256:${sum}"
  headlamp/plugin/version-compat: "${VERSION_COMPAT}"
  headlamp/plugin/distro-compat: "${DISTRO_COMPAT}"
YAML
echo "wrote $out/artifacthub-pkg.yml (ghcr.io/${owner}/${NAME}:${version}, sha256 ${sum})"
