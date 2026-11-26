# Hangar Headlamp plugin image: ghcr.io/kalik1/hangar-headlamp-plugin:<version>
#
# A tiny image that only carries the built plugin at
#   /plugins/hangar-headlamp-plugin/{main.js,package.json}
# Headlamp's pod copies it into its plugins directory with an initContainer
# (see distribution/headlamp-values.yaml). The same image also works as an
# image volume.
#
# Build context: the repository root.
#   podman build -f Containerfile --build-arg PLUGIN_VERSION=0.1.1 \
#     -t ghcr.io/kalik1/hangar-headlamp-plugin:0.1.1 .
#
# The JavaScript is architecture independent: it is built once on the build
# platform; only the tiny runtime base differs per architecture.

ARG NODE_IMAGE=docker.io/library/node:22-alpine
ARG BASE_IMAGE=docker.io/library/busybox:1.37-musl

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY plugin/package.json plugin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY plugin/tsconfig.json ./
COPY plugin/scripts ./scripts
COPY plugin/src ./src
RUN npm run build \
 && mkdir -p /out/hangar-headlamp-plugin \
 && cp dist/main.js package.json /out/hangar-headlamp-plugin/ \
 && test -s /out/hangar-headlamp-plugin/main.js

FROM ${BASE_IMAGE}
ARG PLUGIN_VERSION=dev
LABEL org.opencontainers.image.title="Hangar Headlamp plugin" \
      org.opencontainers.image.description="Virtualization console for KubeVirt and CDI, as a Headlamp plugin, copied into Headlamp's plugins directory by an initContainer" \
      org.opencontainers.image.source="https://github.com/kalik1/hangar" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.version="${PLUGIN_VERSION}" \
      io.hangar.headlamp-plugin.path="/plugins/hangar-headlamp-plugin"
COPY --from=build /out/hangar-headlamp-plugin/ /plugins/hangar-headlamp-plugin/
# Headlamp's uid/gid in its own image and chart (securityContext 100:101).
USER 100:101
CMD ["sh", "-c", "cp -R /plugins/hangar-headlamp-plugin/. /hangar-plugin/"]
