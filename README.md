# Hangar

Hangar is a virtualization console for KubeVirt and CDI, as a
[Headlamp](https://headlamp.dev) plugin. It gives a Kubernetes cluster that
runs VMs the console of a classic virtualizer: an inventory of folders,
hosts and VMs, the VM's front panel with its live screen, consoles,
step-by-step VM creation, templates and clones, snapshots, migrations,
maintenance mode, datastores, networks, an ISO and image library, recent
tasks, events and alarms. Kubernetes stays one switch away (Kubernetes
names, related objects, YAML).

## What you can do

| Area | |
|---|---|
| Inventory | Datacenter → folders (namespaces) → VMs and templates; hosts → running VMs; search by name, IP, host, tag, notes |
| Dashboard | CPU, memory and storage capacity (used, allocated, overcommit), VM states, hosts, alarms, recent tasks |
| VMs | Power on, shut down (guest), restart (guest), suspend, resume, power off, reset; bulk actions; right-click menu |
| Console | Graphical (VNC) and serial consoles, in the page or in windows; Ctrl+Alt+Del and special keys; type text into the guest; screenshots; live thumbnails |
| Create | Wizard: library image, ISO install, disk image URL, container registry, empty disk; CPU/memory or size profile; firmware, Secure Boot, TPM; disks and datastore; networks; cloud-init |
| Configure | CPU, memory, size profile, firmware, persistent UEFI variables and TPM; CPU flags, reservation and limits, hot-add of CPUs and memory; add, attach, expand, eject, remove disks and CD/DVDs, also while the VM runs (hot-plug); disk cache, I/O mode, I/O threads, serial, read-only, shareable, error policy, block size; network adapters (network, model, link up/down, multi-queue); devices (headless, video card, audio, RNG, watchdog, crash reports, VSOCK, host metrics); shared folders (virtiofs); boot order; power policy; behaviour on host maintenance; shutdown timeout; host pinning; tags; cloud-init; notes |
| Options | Delete protection, start paused, guest clock (UTC, time zone, offset), tablet pointer, ACPI, SMBIOS (UUID, serial, chassis), guest OS tuning; machine type (the versions the hosts offer and KubeVirt accepts) |
| Networking | The NAT range of pod-network adapters (vmNetworkCIDR) avoids the cluster's pod, service and host ranges (a VM on a host whose pods use 10.0.2.0/24 could not reach them); Configure fixes existing VMs |
| Settings | KubeVirt's features (feature gates) in plain words: on or off, maturity per KubeVirt version, what each unlocks, the cluster settings they need; turn them on and off; the delete protection policy |
| Copies | Clone, clone to template, new VM from template (disks copied, new hostname, new fixed MAC on NAT adapters) |
| Snapshots | Take, revert, delete |
| Hosts | State, hardware, usage, VMs; maintenance mode with live evacuation |
| Migration | Live migration to a chosen host or the cluster's choice, with the reason when a VM cannot move |
| Storage | Datastores with capacity and capabilities; every disk with its VM, unattached disks |
| Library | Disk images and ISOs: import from URL or registry, upload from the browser, new VM from an image |
| Networks | Pod network and bridged/VLAN networks (Multus); create and delete |
| Published ports | Make a VM's ports reachable inside the cluster, on every host's port (NodePort), on an address of its own (LoadBalancer: MetalLB or Cilium LB IPAM) or at a web address through the ingress with TLS (cert-manager or the ingress's certificate): presets (SSH, RDP, HTTP, …), lists and ranges, TCP and UDP; live state per port (the VM behind it, the host port, the address and the host that announces it, why it failed); "Reachable at" on the VM summary with lines to copy; every published port of the datacenter in Networks |
| Monitoring | Per-VM and per-host CPU and memory charts; guest agent data (OS, users, filesystems) |
| Operations | Recent tasks with confirmed outcomes; events in plain words; alarms |
| Kubernetes | Switch to show object names, related objects, links to Headlamp pages, YAML editor, YAML review before creating a VM |
| Host devices | Each host's PCI devices (GPUs, SR-IOV virtual functions, SAS/SATA/NVMe controllers, NICs), vGPU profiles, USB devices and disks; give a chosen device to VMs or back to the host; device mappings (what VMs can ask for, free per host) with an Add device flow across hosts; add GPUs, PCI and USB devices to a VM; give a whole host disk to a VM |
| Access | Controls a user's role does not allow are disabled with the reason; `distribution/rbac.yaml` has viewer, VM operator and VM admin roles |


## Requirements

| What | For |
|---|---|
| Headlamp v0.46 or newer, in the cluster or as a web app | Hangar is built against `@kinvolk/headlamp-plugin` 0.14.0 (Headlamp v0.46) |
| KubeVirt 1.5 or newer (tested with 1.7) and CDI (tested with 1.64) | Everything |
| metrics-server | Usage charts |
| Multus | Bridged and VLAN networks |
| VolumeSnapshot CRDs, a snapshot controller and KubeVirt's `Snapshot` feature gate | Snapshots |
| Hangar's node agent (below), IOMMU on the hosts | Host devices (PCI, GPU, USB passthrough, host disks) |
| KubeVirt's `Sidecar` feature gate, spice-vdagent in the guest | Clipboard sharing with the console (below) |
| KubeVirt's `DeclarativeHotplugVolumes` feature gate (not with `HotplugVolumes`) | Disks and CD/DVD media in and out of a running VM |
| KubeVirt's `ExpandDisks`, `VideoConfig`, `PanicDevices`, `VSOCK`, `DownwardMetrics`, `EnableVirtioFsStorageVolumes`/`EnableVirtioFsConfigVolumes` feature gates | A running guest sees a disk grow; video card choice; crash reports; VSOCK; host metrics; shared folders |
| The `LiveMigrate` workload update method in the KubeVirt resource | Adding CPUs and memory to a running VM, live disk moves |
| Kubernetes 1.30 or newer and `distribution/protection-policy.yaml` | Delete protection (below) |
| TopoLVM, Rook-Ceph (optional) | Per-host thin pools; Ceph pool capacity and links to [Cairn](https://github.com/kalik1/cairn) |

Without an optional part, Hangar says what is missing instead of offering
broken buttons. It finds KubeVirt's namespace from the KubeVirt resource,
so it works with the KubeVirt operator (`kubevirt`) and with HCO.

## Install

The plugin ships as a small OCI image,
`ghcr.io/kalik1/hangar-headlamp-plugin:<version>`, holding
`/plugins/hangar-headlamp-plugin/{main.js,package.json}` (amd64 and arm64),
and as a tarball on each [GitHub Release](https://github.com/kalik1/hangar/releases)
(`hangar-headlamp-plugin-<version>.tar.gz`, with its sha256).

### Headlamp in the cluster (Helm chart)

An initContainer copies the plugin into Headlamp's plugins directory. With
Headlamp's [Helm chart](https://github.com/kubernetes-sigs/headlamp/tree/main/charts/headlamp),
use [`distribution/headlamp-values.yaml`](https://github.com/kalik1/hangar/blob/main/distribution/headlamp-values.yaml)
(trimmed here; the file also sets resources and drops capabilities):

```yaml
config:
  pluginsDir: /headlamp/plugins
initContainers:
  - name: hangar-plugin
    image: ghcr.io/kalik1/hangar-headlamp-plugin:0.1.1
    imagePullPolicy: IfNotPresent
    command: [sh, -c, "cp -R /plugins/hangar-headlamp-plugin/. /hangar-plugin/"]
    securityContext: {runAsNonRoot: true, runAsUser: 100, runAsGroup: 101, readOnlyRootFilesystem: true}
    volumeMounts: [{name: hangar-plugin, mountPath: /hangar-plugin}]
volumes:
  - {name: hangar-plugin, emptyDir: {sizeLimit: 16Mi}}
volumeMounts:
  - {name: hangar-plugin, mountPath: /headlamp/plugins/hangar-headlamp-plugin, readOnly: true}
```

```bash
helm upgrade --install headlamp headlamp/headlamp --namespace headlamp \
  --reuse-values -f distribution/headlamp-values.yaml
```

Helm replaces lists instead of merging them: if your values already have
`initContainers`, `volumes` or `volumeMounts` (other plugins), add these
entries to your lists. A new version arrives with a new image tag, which
rolls Headlamp's pod.

### From the release tarball

Extract `hangar-headlamp-plugin-<version>.tar.gz` (after checking its
sha256) into a folder named `hangar-headlamp-plugin` in Headlamp's plugins
directory; the archive holds `main.js` and `package.json` under one top
folder:

```bash
mkdir -p "$PLUGINS_DIR/hangar-headlamp-plugin"
tar -xzf hangar-headlamp-plugin-0.1.1.tar.gz --strip-components=1 \
  -C "$PLUGINS_DIR/hangar-headlamp-plugin"
```

### Roles

[`distribution/rbac.yaml`](https://github.com/kalik1/hangar/blob/main/distribution/rbac.yaml) has the roles for users
other than cluster-admin: `hangar-viewer`, `hangar-vm-operator` and
`hangar-vm-admin` (bind them per folder with a RoleBinding, or cluster-wide
with a ClusterRoleBinding), and `hangar-hardware-admin` for host devices.
Controls a user's role does not allow are disabled with the reason.
`hangar-vm-admin` may create Secrets, only to keep a VM's cloud-init user
data when it is longer than KubeVirt takes inline (2,048 bytes); no role
reads, lists or changes Secrets.

```bash
kubectl apply -f distribution/rbac.yaml
```

The `hangar-reload-devices` Role lives in KubeVirt's namespace (`kubevirt`
in the file): change it if KubeVirt runs elsewhere. The part of
`hangar-hardware-admin` in `hangar-system` comes with the node agent
(below).

### Host devices (passthrough)

KubeVirt passes a host device to a VM only after it is bound to vfio-pci
on its host, and the API has no list of a host's hardware. Hangar's node
agent does both: a DaemonSet in `hangar-system` (busybox, scripts in a
ConfigMap) that publishes each host's PCI, USB and disk inventory and
binds the devices you give to VMs, with a udev rule so they stay bound
after a reboot. It gives back to the host only what it bound itself, and
refuses what the host needs (its disk controllers, the NICs that carry its
addresses, anything in their IOMMU groups).

```bash
kubectl apply -k distribution/node-agent
```

Hosts need the IOMMU on: VT-d/AMD-Vi in the firmware and
`intel_iommu=on iommu=pt` (or `amd_iommu=on iommu=pt`) on the kernel
command line. Hangar turns on KubeVirt's `HostDevices` feature gate with
the first device mapping. People who manage devices need
`hangar-hardware-admin`: the ClusterRole of `distribution/rbac.yaml` and
the Role of the same name in `hangar-system`
(`distribution/node-agent/rbac.yaml`), bound to the same subjects.

Undo: give the devices back to the host from each host's Hardware tab,
delete the mappings, then `kubectl delete -k distribution/node-agent` and
`kubectl -n hangar-system delete configmap hangar-passthrough`. A host that
still has `/etc/udev/rules.d/60-hangar-vfio.rules` binds those devices to
vfio-pci at boot until the file is removed.

### The image library

Hangar keeps disk images and ISOs in one namespace, `hangar-library` by
default. The Library view creates it on first use, with the RBAC that
lets every folder clone from it (`datavolumes/source`).


### Clipboard sharing

Copy and paste between your computer and a VM's graphical console is a
per-VM switch (Configure, or the New VM wizard's last step). It runs a
KubeVirt hook sidecar (KubeVirt's own `sidecar-shim` image and a small
script in a ConfigMap of the VM's folder) that gives the VM a
`qemu-vdagent` port. It needs:

- KubeVirt's `Sidecar` feature gate. It is cluster-wide (anyone who may
  edit VMs can then add hook sidecars): Hangar asks before turning it on,
  and only a user who may update the KubeVirt resource can;
- spice-vdagent in the guest and an unlocked desktop session;
- a restart of the VM.

On plain http the browser lets Hangar write your clipboard only right after
a key press or click in the console.

### KubeVirt features

Settings → Features lists KubeVirt's feature gates in plain words: on or
off, how mature each one is (GA features are always on; Alpha ones only when
listed in the KubeVirt resource; Beta ones only when listed up to KubeVirt
v1.8, and unless disabled from v1.9), what it unlocks in Hangar and
which VMs use it, next to the cluster settings some of them need
(LiveMigrate updates, live updates, hot-add ceilings, where UEFI and TPM
state is kept, the default behaviour on host maintenance). The maturity
table is per KubeVirt minor version (v1.7 to v1.10, taken from their
sources); for another version Hangar says the maturity is unknown. A user who may patch the
KubeVirt resource turns a feature on or off there: Hangar changes only the
feature gate lists (featureGates, disabledFeatureGates), read fresh before
writing, and never writes
`HotplugVolumes` together with `DeclarativeHotplugVolumes`. Controls
elsewhere that need a feature that is off are disabled with the reason and
a link to it.

### Published ports

Configure → Published ports makes a VM's ports reachable through a
Kubernetes Service that selects its pod (KubeVirt's `vmi.kubevirt.io/id`
label, as `virtctl expose` does) and is owned by the VM, so it goes with it:

- **inside the cluster** (ClusterIP): `<vm>-cluster.<folder>.svc`;
- **on every host's port** (NodePort, 30000-32767): if firewalld runs on the
  hosts, open that range there (the node agent tells Hangar where it runs);
- **on an address of its own** (LoadBalancer): from an address pool an admin
  made, a MetalLB `IPAddressPool` with an `L2Advertisement`, or a Cilium
  `CiliumLoadBalancerIPPool` with a `CiliumL2AnnouncementPolicy` and
  Cilium's L2 announcements on. Hangar never creates a pool, and never uses
  k4all's `k4all-ingress-pool` (the ingress's own address);
- **at a web address through the ingress** (an Ingress `<vm>-web-<hash>`, for
  an HTTP port of the guest): `https://<name>/`, with TLS ending at the
  ingress. Through Traefik the address answers on HTTPS (443) only. The
  panel suggests `<vm>-<folder>.<ingress address>.nip.io`, a name public
  wildcard DNS resolves by itself. The certificate comes from a cert-manager
  issuer (a ClusterIssuer, or an Issuer of the folder), or is the ingress's
  default certificate, which browsers warn about. Hangar shows the address
  the name must point at, the certificate's state (from the Ingress and its
  Certificate, never the Secret) and tests the address once from the
  browser. Deleting the VM deletes the Ingress and cert-manager's
  Certificate; the certificate's Secret stays unless cert-manager runs with
  `--enable-certificate-owner-ref` (k4all's does not).

Only an adapter on the pod network with NAT (masquerade) or passt can
publish; a VM on a bridged or VLAN network has its own address there. When
the adapter lists `ports`, only those reach the guest: Hangar adds the
published ones, which the guest gets at its next restart. The guest must
listen on the port and its firewall allow it.

Roles: `hangar-viewer` reads Services, EndpointSlices, the address pools,
Ingresses and IngressClasses, cert-manager's Certificates, Issuers and
ClusterIssuers (no Secrets); `hangar-vm-operator` publishes (create, patch,
delete on Services and Ingresses); changing the adapter's port list is a VM
edit (`hangar-vm-admin`). A role bound per folder cannot list the
cluster-wide IngressClasses and ClusterIssuers: the panel then takes the
class by name and offers the folder's Issuers and the default certificate.
Who announces an address shows when the user may also read MetalLB's
`servicel2statuses` (metallb-system) or Cilium's L2 leases (kube-system);
Hangar's roles do not grant them.

### Delete protection

Configure → Options → Protection is Proxmox's protection flag: nobody can
delete the VM or its disks (from Hangar, kubectl, or by deleting the
folder) until it is turned off. Hangar labels the VM and its disks
`hangar.magesgate.com/protected=true`; a ValidatingAdmissionPolicy refuses
the delete. The label alone protects nothing, so Hangar offers the switch
only when the policy is installed (Settings → Delete protection says so):

```bash
kubectl apply -f distribution/protection-policy.yaml
```

Remove it with `kubectl delete -f distribution/protection-policy.yaml`.

Deleting a namespace that holds protected VMs or disks stops halfway: it
stays in Terminating until their protection is turned off. Headlamp's
Namespace page shows a "Protected from deletion (Hangar)" section with them
before you delete; Hangar itself offers no folder delete. CDI's temporary
claims (labelled `cdi.kubevirt.io/OwnedByUID`) copy the label and are left
deletable by the policy.

### Cluster objects for distributions

Each [GitHub Release](https://github.com/kalik1/hangar/releases) also
carries the cluster objects of that version, for distributions that
install them next to the plugin image:

- `hangar-cluster.yaml`: the roles and the delete protection
  (`distribution/rbac.yaml` and `distribution/protection-policy.yaml`);
- `hangar-node-agent.yaml`: the node agent (`distribution/node-agent`,
  built with kustomize), privileged, in its own file so a distribution can
  leave it out.

### On k4all

[k4all](https://github.com/gpillon/k4all) v2.7.0 and later install Hangar
with virtualization on: the plugin in Headlamp, the roles, the delete
protection and the node agent, from this repository's releases. Nothing to
do; a ClusterConfig override from the file below can stay (k4all keeps its
own pin of the plugins it ships) or go.

Older k4all releases configure Headlamp through their ClusterConfig, so the
plugin survives k4all upgrades:
[`distribution/k4all-headlamp-overrides.yaml`](https://github.com/kalik1/hangar/blob/main/distribution/k4all-headlamp-overrides.yaml).

```bash
kubectl patch clusterconfig k4all-cluster-config --type merge \
  --patch-file distribution/k4all-headlamp-overrides.yaml
```

Helm lists replace, so the file repeats the k4all plugin's own
initContainer, volume and mount: keep its tag in step with the k4all
release. Headlamp must be `Managed` by k4all for the override to apply.

## Build

```bash
cd plugin
npm ci
npm run lint && npm run tsc && npm test && npm run build   # dist/main.js
npm run package                                            # the release tarball

# the image, from the repository root
podman build -f Containerfile --build-arg PLUGIN_VERSION=0.1.1 \
  -t ghcr.io/kalik1/hangar-headlamp-plugin:0.1.1 .
```

`npm test` runs `headlamp-plugin test` (vitest with the plugin's own
configuration; plain `vitest run` lacks it).

## Release

1. Set the version in `plugin/package.json` (`npm version <x.y.z>
   --no-git-tag-version` in `plugin/`), in the image tags of `distribution/`
   and in this README; merge to main.
2. Tag main `v<x.y.z>` and push the tag. The
   [release workflow](https://github.com/kalik1/hangar/blob/main/.github/workflows/release.yaml) checks that the tag
   matches the files, runs CI, pushes the image for amd64 and arm64,
   publishes a GitHub Release with the tarball, its sha256, its
   `artifacthub-pkg.yml` and the cluster objects (`hangar-cluster.yaml`,
   `hangar-node-agent.yaml`), and commits that metadata to
   `artifacthub/hangar-headlamp-plugin/<x.y.z>/` on main for
   [Artifact Hub](https://artifacthub.io) (repository kind *Headlamp
   plugins*, URL `https://github.com/kalik1/hangar/artifacthub`).
   To claim the listing, set the repository ID from artifacthub.io in
   `artifacthub/artifacthub-repo.yml`.
3. A release candidate is a tag with a suffix, `v<x.y.z>-rc.<n>`: only
   `plugin/package.json` takes that version, and README.md and
   `distribution/` keep the pins of the last release. The workflow
   publishes the same image and assets as a GitHub pre-release, which never
   becomes the latest release, and commits nothing to `artifacthub/`.

Design notes: [DESIGN.md](https://github.com/kalik1/hangar/blob/main/DESIGN.md).

## License

GPL-3.0-only: see [LICENSE](https://github.com/kalik1/hangar/blob/main/LICENSE).
