# Hangar: design

Hangar is a Headlamp plugin that gives KubeVirt and CDI the console of a
classic virtualizer. It is a separate addon from the k4all plugin: it works
on any cluster with KubeVirt, and k4all installs it like any other Headlamp
plugin (see README.md).

## 1. The idea

KubeVirt and CDI are a complete hypervisor stack without a console. People
who run VMs think in VMs, hosts, datastores, networks, ISOs, templates,
snapshots and consoles, not in PVCs, DataVolumes, NADs and pods. Hangar
speaks their language everywhere, and keeps Kubernetes one switch away:
the **Kubernetes** switch in the top bar shows the object names next to the
virtualizer words, adds a Kubernetes tab with the objects behind a VM and
the YAML editor, and lets the New VM wizard open the YAML before creating.

| Hangar says | Kubernetes object |
|---|---|
| Datacenter | the cluster |
| Host | Node |
| Folder | Namespace |
| Virtual machine | VirtualMachine (+ VirtualMachineInstance while running, + virt-launcher pod) |
| Template | a VirtualMachine labelled `hangar.magesgate.com/template: "true"`, kept off |
| Disk | PersistentVolumeClaim, usually created by a DataVolume |
| Datastore | StorageClass (+ CDI StorageProfile) |
| Image, ISO (library) | DataVolume/PVC labelled `hangar.magesgate.com/image: "true"` in the library namespace |
| Network | the pod network (NAT), or a Multus NetworkAttachmentDefinition (bridge, OVS, VLAN) |
| Size profile | VirtualMachineClusterInstancetype |
| Guest OS tuning | VirtualMachineClusterPreference |
| Snapshot, revert | VirtualMachineSnapshot, VirtualMachineRestore |
| Migrate (move while running) | VirtualMachineInstanceMigration |
| Maintenance mode | cordon the node, then migrate its VMs away |
| Host device (GPU, PCI, USB passthrough) | `gpus` / `hostDevices` in the VM, by resource name |
| Device mapping | an entry of the KubeVirt CR's `permittedHostDevices` (PCI by vendor:device, vGPU by mdev type, USB by vendor/product) |
| Give a device to VMs | the node agent binds it to vfio-pci on its host (ConfigMap `hangar-system/hangar-passthrough`) |
| Give a disk to a VM | a local Block PersistentVolume on `/dev/disk/by-id/...` + a PVC in the VM's folder |
| Power policy | `spec.runStrategy` |
| On host maintenance | `evictionStrategy` |
| Guest customization | cloud-init NoCloud user data |
| Options (Proxmox) | `startStrategy`, `domain.clock`, `devices.inputs`, `features.acpi`, `firmware.uuid/serial` + `domain.chassis`, `spec.preference` |
| Protection | the label `hangar.magesgate.com/protected=true` on the VM and its disks, enforced by a ValidatingAdmissionPolicy (`distribution/protection-policy.yaml`) |
| Hot-plug, hot-add | hot-pluggable volumes (`DeclarativeHotplugVolumes`), more sockets/memory up to `maxSockets`/`maxGuest` (live update through a live migration) |
| Shared folder | `devices.filesystems[].virtiofs` + a PVC, ConfigMap or Secret volume |
| Datacenter features | the KubeVirt resource's `developerConfiguration.featureGates` |

## 2. Screens

One Headlamp route, `/hangar/:view?/:a?/:b?/:c?`, so the app shell stays
mounted while you move: the inventory tree keeps its state, the metrics
history keeps growing, the tasks keep being followed.

- **Top bar**: product mark, datacenter (cluster) with host and VM counts,
  search across VMs (name, IP, host, tags, notes) and hosts, the Kubernetes
  switch, New VM. Below it the views: Dashboard, Virtual machines, Hosts,
  Storage, Networks, Flavors, Tasks & events, Settings.
- **Inventory tree** (left, resizable, can be hidden): datacenter → folders
  → VMs and templates; in the host views, datacenter → hosts → the VMs
  running on each. LEDs show power state. Arrow keys move, Right/Left
  expand/collapse, Enter opens, right-click or the context-menu key opens
  the VM's menu.
- **Recent tasks** (bottom dock): every operation started from Hangar, with
  its outcome confirmed from the live objects (see 4).
- **Dashboard**: CPU, memory and storage capacity (used, allocated to VMs,
  overcommit), VM states, hosts with usage, alarms, recent tasks.
- **Virtual machines**: sortable list with power state, guest
  OS, folder, host, IP, vCPU, memory, storage, CPU usage sparkline, uptime,
  tags; filter by state and text; bulk power on, shut down, restart,
  suspend, resume, power off, delete; right-click menu.
- **VM page**: the faceplate (3), a "restart to apply your changes" bar
  when KubeVirt reports RestartRequired, then tabs:
  - Summary: guest (agent: OS, hostname, kernel, IPs, users, filesystems
    with usage), hardware and devices, notes (edit in place), tags, usage,
    "Reachable at" (each address the VM answers on, with the line to copy:
    `ssh -p 30022 user@host`, `http://192.0.2.10/`, the cluster DNS name, its
    own address on a secondary network), placement and policies (host,
    folder, power policy, maintenance behaviour, live-migration capability
    and why not), recent tasks.
  - Console: graphical (noVNC) and serial (xterm.js) consoles, embedded or
    in their own browser window (a pop-up on the route
    `/hangar-console/:namespace/:name/:kind`, no app bar or sidebar, one
    window per VM: opening it again brings it back). While the window is
    open the Console tab steps aside (KubeVirt serves one client per VM;
    the windows tell each other through a BroadcastChannel). If the browser
    blocks pop-ups the console opens in an in-page window (Headlamp
    activity) that says so.
  - Clipboard sharing (Configure → Clipboard sharing, or the wizard's last
    step): a KubeVirt hook sidecar (feature gate `Sidecar`, KubeVirt's
    sidecar-shim image, a script in the ConfigMap `hangar-clipboard-hook`
    of the folder) gives the VM a `qemu-vdagent` port with copy/paste and
    no mouse, so QEMU's VNC server and spice-vdagent in the guest share the
    clipboard through noVNC's extended clipboard. The port goes in as QEMU
    arguments because KubeVirt re-reads the hook's XML and drops
    `<clipboard/>`. In the console, Ctrl+V (Ctrl+Shift+V, Shift+Insert) is
    kept from noVNC, the browser's paste lands in a hidden field, the text
    goes to the VM when this computer's clipboard changed, then the VM gets
    the shortcut. What the VM copies shows in the console's Clipboard panel
    and goes to this computer's clipboard on https, or right after
    Ctrl+C/X in the console on plain http (a user gesture); otherwise the
    panel's "Copy to this computer" does it. VMs without it keep "Type
    text".
  - Configure: CPU/memory/size profile, firmware and TPM (with persistent
    UEFI variables and TPM state), CPU flags (require/disable, with the hosts
    that offer each flag from KubeVirt's node labels), reservation and
    limits, hot-add ceilings and, for a running VM, what applies at once
    (more sockets up to maxSockets and memory between the boot size and
    maxGuest go in through a live migration; the rest at restart, with the
    reason); disks and CD/DVD (add new, attach existing, insert an ISO,
    expand, eject, remove, delete; while running with DeclarativeHotplugVolumes:
    VirtIO/SCSI disks in and out, ISOs into an empty drive that existed at
    power-on; per-disk cache, I/O mode, own I/O thread, serial, read-only,
    shareable, error policy, block size; I/O threads and multi-queue for the
    VM); network adapters (network, model, MAC, link up/down on every
    binding but SR-IOV, live; multi-queue); Devices (headless, video card,
    audio, VirtIO RNG, i6300esb watchdog, pvpanic, VSOCK, host metrics);
    Shared folders (virtiofs from a disk, ConfigMap or Secret, with the
    guest's mount command); vGPU display and boot framebuffer for mediated
    GPUs; Options (delete protection, start paused, clock, tablet pointer,
    ACPI, SMBIOS, guest OS tuning); machine type (`domain.machine.type`:
    the types the hosts report through machine-type.node.kubevirt.io that
    match the KubeVirt resource's emulatedMachines, else KubeVirt's
    defaults q35*/pc-q35*, with the datacenter default; restart-only; a
    running VM keeps its resolved type when it moves, because its pod asks
    for hosts that offer it). Pod-network adapters: the NAT range
    (`networks[].pod.vmNetworkCIDR`, KubeVirt's default 10.0.2.0/24) must
    not overlap a host's pod range (CiliumNode spec.ipam.podCIDRs, else
    Node podCIDRs, else pod addresses), the service range (ServiceCIDR,
    else a /16 around the kubernetes Service) or a host address, or the VM
    cannot reach them (k4all #72: a Cilium host's pods in 10.0.2.0/24). The
    wizard picks 10.0.2.0/24 when free, else 172.31.254.0/24 downwards
    (shown behind the Kubernetes switch); Configure warns about an
    overlapping adapter with a fix (next restart). Controls whose KubeVirt feature gate is
    off are disabled with one line and a link to Settings → Features, but
    can always be turned off. Where Proxmox has an option KubeVirt lacks
    (start order, KVM on/off, SPICE, hibernation, disk QoS and SSD
    emulation, ROM-Bar, x-vga, vIOMMU, USB hot-plug), Hangar says so where
    a user looks for it. DNS of
    the pod network adapter (what the guest gets by DHCP — cluster DNS,
    search domains, the hosts' domains — and the VM's dnsPolicy/dnsConfig:
    cluster first, the host's servers, or only listed servers; also in the
    wizard's Network step); boot order; power policy, maintenance behaviour, shutdown timeout, host
    pinning; tags; cloud-init. **Published ports** (below).
  - Snapshots: take, revert, delete.
  - Monitor: CPU and memory over the last 30 minutes.
  - Events: of the VM and everything behind it, in plain words.
  - Kubernetes (with the switch on): related objects, links to Headlamp's
    own pages, Edit YAML.
- **New VM wizard**: name and folder (a new folder is created on the fly),
  operating system and boot source (library image, ISO install, URL,
  container registry, empty disk), CPU and memory (custom or size profile,
  firmware, TPM), disks and datastore, network adapters, guest
  customization (form or own cloud-config), review with power policy and
  maintenance behaviour, Create (or Review YAML). The form adds the user
  `k4all` by default as a `users:` entry (cloud-init deprecates `user:`)
  with what an image's default user has (sudo without a password, bash
  where the OS has it), its password and SSH keys; with the user field
  empty the image's own default user gets them. Ubuntu and Debian images
  lack the QEMU guest agent: `packages` installs it. "Let the guest agent
  reach the whole guest" (off by default, not with an own cloud-config,
  `GUEST_AGENT_FULL_ACCESS`) adds, at first boot, a systemd drop-in with an
  empty `FILTER_RPC_ARGS` (every agent command on RHEL and Rocky), a CIL
  module where SELinux is on (`virt_qemu_ga_t` in `files_unconfined_type`
  with chown, fowner and fsetid: every file, the domain stays enforcing)
  and a restart of the agent, merged into the same `packages`,
  `write_files` and `runcmd` keys; the wizard states the trade-off
  (anyone with `hangar-guest-admin` on the VM can change every file as
  root). KubeVirt refuses
  inline user data over 2,048 bytes (`cloudInitUserMaxLen`): `createVm`
  (`api/cloudInit.ts`) keeps longer user data in a Secret of the VM's
  folder (`cloudInitNoCloud.secretRef`, key `userdata`) and refuses with
  the reason when it cannot make it; the review says so. It needs only
  `create` on Secrets (hangar-vm-admin): a dry run of the Secret first
  (refused: nothing is created), then the VM, which gives its UID, then
  the Secret with the VM as its owner, so the garbage collector deletes it
  with the VM and nothing is patched; if that Secret still fails, the VM
  is deleted again. A VM created running waits for the Secret that long
  (the kubelet retries the mount). No Hangar role reads Secrets. On k4all, guest
  customization also asks for k4all's metadata service on 169.254.169.254
  (on by default when k4all's ClusterConfig turns it on:
  `spec.features.virt.metadata.enabled`, read instead of looking for the
  admission policy, whose name is k4all's own detail): the template label
  `k4all.magesgate.com/metadata: enabled`, `chassis.asset: OpenStack Nova`
  (cloud-init looks for the service only with it) and a ServiceAccount
  picker (label `k4all.magesgate.com/service-account`, the folder's
  `default` without it). The cloud-init disk stays: VMs in folders that
  enforce PodSecurity baseline or restricted are not injected and keep
  using it (D8). The VM summary says whether the VM gets the service, what
  it serves (instance-id = the VM's UID, cloud-init data, tokens) and why
  not (service off, not asked or opted out with
  `k4all.magesgate.com/metadata: disabled` under scope All, no pod network
  adapter, PodSecurity). k4all's Warning Events on the VM (reason
  `Metadata…` from a k4all component) are history, not state: k4all
  cannot clear them, they fade with the Event TTL (an hour by default).
  They become notes with their age ("k4all, 12m ago: …"), the newest of
  each reason, and those older than the running instance are dropped;
  `MetadataNotServed` marks the VM not served only when Hangar cannot read
  the folder, whose labels are current, and `MetadataChassisAsset` is left
  to the spec check below. Hangar does not read the `k4all-md-<vm>` Secret
  for the current state: even metadata only needs `get` on Secrets, which
  also returns their data (user-data, tokens), and a viewer role must not
  need that. k4all sets the asset tag on the VMs
  it serves when they have none; a tag of the user's wins, and then
  cloud-init never looks for the service: the summary and the SMBIOS row
  and dialog say so for VMs that get the service.
- **Clone, clone to template, new VM from template**: every persistent disk
  is copied with CDI; the copy gets a new fixed MAC on its NAT adapters
  (none on the others), a new firmware UUID and serial, and its own
  hostname in cloud-init. User data the source keeps in a Secret goes into
  a Secret of the copy's own, in the same order: never inline, where
  anyone who may read the VM would see it. Reading the source's Secret
  needs `get`, which no Hangar role gives; without it the dialog says what
  the copy gets: in the same folder the source's Secret (its hostname,
  gone with the source), in another folder no cloud-init user data (a
  reference to a Secret that is not there would keep it from starting).
- **Hosts**: list with state, VMs, CPU and memory usage, hardware; host
  page with resources (used and allocated), its VMs and whether each can
  move live, usage charts, events, **Enter/Exit maintenance mode**.
  Its **Hardware** tab lists what the node agent reads on the host: PCI
  devices by kind (graphics and accelerators, storage controllers with
  SAS/SATA/NVMe named as such, network, USB controllers, audio, other;
  bridges and chipset on request), each with address, IDs, driver, IOMMU
  group, SR-IOV relations and vGPU profiles, and a state with an LED: with
  the host (its driver), preparing, ready for VMs (and in which mapping),
  in use by a VM (link), kept for the host (its disk controller, the NICs
  that carry its addresses, their IOMMU groups) with the reason. Actions:
  **Give to VMs** (the device and its IOMMU group mates; joins the
  mapping of identical devices or creates one), **Give back to host**,
  **Offer to VMs** for USB devices and vGPU profiles, **Give to a VM** for
  free disks, **Take back**, **Reload devices**. Banners say when the
  IOMMU is off (on k4all with a link to the addon's node settings,
  `/k4all/settings/nodes`, which adds the kernel arguments), when KubeVirt's
  passthrough gate is off, and when devices were prepared after KubeVirt's
  agent started (so VMs may not get them).
- **Device mappings** (from Hosts): what VMs can ask for, Proxmox's
  resource mappings: name, kind (GPU, PCI device, vGPU profile, USB
  device), what it matches, free of total per host, the VMs asking for
  it; rename, delete. **Add device** (button, empty state, and "Add
  another host's device" on a PCI mapping's row) is the way in from the
  datacenter: kind (GPU or accelerator, storage controller, network
  controller, other PCI, USB device, vGPU profile, host disk), then the
  exact devices across the hosts (live inventory, filter by host, each
  with driver, IOMMU group, state, and why it cannot be given), then the
  mapping (new; identical PCI devices always share theirs), then review.
  It runs the Hardware tab's flow on every chosen host in parallel (one
  task per host), then creates the mapping once or reloads each host. A VM's **Configure** has a Host devices panel: the
  devices it asks for and the physical one it holds while running, Add
  (pick the mapping with its free count per host, optionally only one
  host), Remove; its Summary lists them.
- **Storage**: four sections, each deep-linkable as
  `/hangar/storage/<section>` (old `/hangar/library` and `/hangar/templates`
  links redirect here):
  - *Datastores*: StorageClasses in plain words (type, live migration,
    snapshots, expansion, how disks are copied, what happens to deleted
    disks) with honest capacity: for TopoLVM thin pools the node annotations
    report the overprovisioning limit, so Hangar reads the real pool usage
    from the topolvm-node metrics (needs `pods/proxy`) and says when it
    cannot; Ceph pools show usable space after replication and the
    cluster's health. Actions: New datastore (a StorageClass copied from an
    existing one of the same driver, so its secrets come along; pick the
    Ceph pool or TopoLVM device class, reclaim, binding, expansion; YAML in
    Kubernetes mode), make one the default for new VMs
    (`storageclass.kubevirt.io/is-default-virt-class`, which CDI prefers to
    the cluster default), delete an empty one.
  - *Disks*: every disk with the VM using it, folder, size, datastore and
    the host of local ones, its volume snapshots and state; unattached disks
    are flagged; move to another datastore, expand, attach an unattached
    disk to a VM of its folder, delete (DataVolume first, then the PVC). CDI
    internals (`prime-*`, scratch, tmp) are hidden.
  - *Images*: the library, disk images and ISOs in the library namespace;
    import from a URL or a container registry, upload from the browser
    (upload token, then the file straight to CDI's upload proxy with
    progress), edit name and OS, delete, New VM from an image; CDI
    DataSources and DataImportCrons as boot sources. It creates the library
    and its sharing RBAC on first use and repairs the sharing if it is
    missing.
  - *Templates*: VMs labelled `hangar.magesgate.com/template`, with guest
    OS, folder, size, disks and their datastores; New VM from a template,
    edit, clone into another template, convert back to a VM, delete; New
    template from a powered-off VM (clone it or convert it).
  - Ceph-backed datastores and disks link to the Ceph plugin (pool, RBD
    image) when that plugin is installed: Hangar finds its routes
    (`/ceph/pools/:pool`, `/ceph/rbd/:pool/:image`) among the routes
    Headlamp registered, so a missing plugin never gives a dead link.
- **Networks**: the pod network and the Multus networks parsed from their
  CNI config (type, bridge, VLAN, MTU, folders, VMs using them); create a
  bridge/OVS network offering only what the hosts have (nmstate
  NodeNetworkState, ovs-cni resources); delete when unused; every
  published port of the datacenter (`/hangar/networks/ports`: VM, port,
  how, address, state, conflicts: a guest port published twice the same
  way, an address and port two Services claim, a Service whose VM is
  gone); a per-host panel of NICs, bonds, VLANs and bridges.
- **Published ports** (VM → Configure; `src/model/ports.ts`,
  `src/api/ports.ts`): a Service per VM and way of publishing,
  `<vm>-cluster` (ClusterIP, "inside the cluster"), `<vm>-nodeport`
  (NodePort, "on every host's port") and `<vm>-lb` (LoadBalancer, "on an
  address of its own", `allocateLoadBalancerNodePorts: false`), labelled
  `app.kubernetes.io/managed-by: hangar` and `hangar.magesgate.com/vm`, owned
  by the VM (controller, blockOwnerDeletion false, as `virtctl expose`
  from KubeVirt v1.9), so deleting the VM deletes them. Other Services that
  select the VM's pod show read-only. Ports: presets in the order the guest
  OS suits (SSH first for Linux, RDP and WinRM for Windows), lists and
  ranges expanded to one Service entry each (at most 100 at once), TCP or
  UDP; duplicates and guest ports the VM already publishes that way are
  refused; a chosen host port is checked against the Services the user can
  see. Only a pod-network adapter with masquerade or passt publishes (a
  pod bridge has no pod address; Multus adapters have their own address,
  shown instead). When the adapter lists `ports` (or `portRanges`), only
  those reach the guest: Hangar adds the published ones (a VM edit, at the
  next restart, with "Restart now"); a published port missing from the
  list is flagged on its row. LoadBalancer pools: MetalLB IPAddressPools
  and Cilium CiliumLoadBalancerIPPools with their free addresses (the
  controller's count, `status.availableIPv4` or `cilium.io/IPsAvailable`),
  those that cannot serve the VM's Service with the reason
  (serviceAllocation, serviceSelector, turned off, full), never
  `k4all-ingress-pool`; with no usable pool the mode is off and says what
  an admin creates for the CNI. Hangar always names the MetalLB pool
  (`metallb.io/address-pool`), so MetalLB never picks the ingress's; a
  Cilium pick with MetalLB also installed gets Cilium's class
  `io.cilium/l2-announcer`, which MetalLB leaves alone. Each row's live
  state, from objects polled every 5 s while the panel is open: the
  Service (the publish change's pending → done | failed row), the VM behind
  it (EndpointSlices: ready, not ready yet, off, its pod not selected), the
  allocated host port and every host's address (IPv4 unless the guest has
  IPv6) with firewalld's warning (the node agent reports it; k4all's
  `k4all-cni-firewalld` opens only the CNI's ports), the LoadBalancer
  waiting / assigned (address, pool) / announced (MetalLB: ServiceL2Status
  or the speaker's `nodeAssigned` Event; Cilium: the holder of the lease
  `cilium-l2announce-<ns>.<svc>` in kube-system) / failed (MetalLB
  `AllocationFailed`, Cilium `cilium.io/IPAMRequestSatisfied=False`, in
  words). Every change is also a task.
  **A web address** (H-08b, `src/model/web.ts`, `src/api/web.ts`): an HTTP
  port of the guest at `https://<host>/` through the cluster's ingress, one
  Ingress per address (`<vm>-web-<hash5 of the host>`, owned by the VM,
  labelled like the Services), whose backend is the VM's `<vm>-cluster`
  Service (its port is added when missing, so the selector and the "VM
  behind it" state are the same). TLS ends at the ingress; a guest serving
  only HTTPS publishes on its own address or a host port instead. The class
  is the default one, else the only one, else the user picks; through
  Traefik's controller (`traefik.io/ingress-controller`) the Ingress gets
  `router.entrypoints: websecure` and `router.tls: "true"`, so the VM is
  never reachable over plain HTTP through the ingress and no redirect
  Middleware is needed; other controllers get no controller annotation and
  their own behaviour applies. The host: a DNS-1123 name, no wildcard, not
  used by an Ingress Hangar can see; suggested `<vm>-<folder>.<ingress
  IPv4>.nip.io` (the address from an Ingress status of the class, else
  Traefik's Service). The certificate: a cert-manager ClusterIssuer or
  folder Issuer with its Ready condition (the annotation and `spec.tls` with
  `<ingress>-tls`; an ACME HTTP-01 issuer is refused for a nip.io name of a
  private address), or the ingress's default certificate with the browser
  warning said plainly and no `spec.tls`. The row: the address the name
  must point at (the Ingress's `status.loadBalancer`, or "waiting for the
  ingress to publish its address"), the TLS state from the Ingress and
  `certificates.cert-manager.io` (default / requesting / valid until /
  failed / unknown: no right to read Certificates, or a Secret made
  elsewhere), never from a Secret, and a one-time URL test: one no-cors
  fetch with a 5 s timeout, whose answer proves only that this browser
  reached the name and trusted a certificate for it; a failure cannot tell
  DNS, routing and TLS apart, so it says so next to a link that opens the
  address. Headlamp (v0.46) sets no Content-Security-Policy on its page
  (only `sandbox` on service-proxy responses); a policy that refuses the
  fetch (a `securitypolicyviolation`) hides the button.
- **Flavors** (`/hangar/flavors/vm|cpu|tuning`):
  - VM flavors: KubeVirt instancetypes grouped in families with plain names
    (Balanced, Burstable, CPU intensive, Memory intensive, Network
    functions, Real time, and Hangar's own), each size with vCPU, memory,
    CPU model, extras (dedicated CPUs, huge pages, NUMA, overcommit, GPU),
    the hosts that can run it (CPU manager, huge pages, CPU model, device
    resources from the node; on k4all a missing CPU manager or huge pages
    links to the addon's node settings, `/k4all/settings/nodes`) and the
    VMs using it. KubeVirt's flavors are
    read-only ("Make a custom copy"); Hangar's (label
    `hangar.magesgate.com/flavor-family`, cluster-wide or one folder) are
    created as a ladder of sizes from a purpose and a memory-per-vCPU
    ratio, edited, extended and deleted when unused.
  - CPU models: per host its maker and host model; presets with a verdict
    (Portable — every host, Portable per maker, Host model, Host
    passthrough); the cluster default (`spec.configuration.cpuModel`); the
    templates with their effective model and "Make portable"; the host ×
    model matrix with instruction sets. The wizard and Configure offer the
    same choice with the same verdict; a flavor with a model locks it.
  - Guest OS tuning: KubeVirt preferences, read-only, with the VMs using
    them.
- **Snapshots** (VM tab): a timeline from "Now" with reverts between
  snapshots; each snapshot says what it holds and whether it is quiesced
  (guest agent), crash-consistent or taken off; take, revert (shut down or
  power off first, optional safety snapshot, power on after), delete. When
  the cluster lacks something (CRDs, the KubeVirt `Snapshot` feature, a
  snapshot class for the datastore) the tab says exactly what.
- **Tasks & events**: all tasks, and the virtualization events of the
  cluster (VMs, instances, migrations, disks, snapshots, host processes).
- **Settings** (Datacenter settings, `/hangar/settings/features|protection`,
  where Proxmox has Datacenter → Options and vSphere the cluster's
  Configure tab):
  - *Features*: KubeVirt's feature gates grouped by what they unlock in
    Hangar (disks, devices, sharing, CPU and memory, network), each with an
    LED (on, off, always on), its maturity (GA, Beta, Alpha, Deprecated,
    Discontinued, or unknown), where it shows in Hangar and the VMs that
    use it; other gates listed in the KubeVirt resource, and the rest of
    the version's table on request. The maturity table is keyed by KubeVirt
    minor version (`src/model/gateTables.ts`: v1.7.0, v1.8.4, v1.9.1 and
    v1.10.0 sources; from v1.9 Beta gates are on by default and turned off
    through disabledFeatureGates); for
    another version maturity is "unknown" and an unlisted gate's state is
    unknown too. Next to it, the cluster settings those features need:
    LiveMigrate workload updates, vmRolloutStrategy, the hot-add ratio and
    ceilings, the VM state datastore (as KubeVirt picks it:
    vmStateStorageClass, else the default VM datastore, else the cluster
    default, RWO unless its profile offers RWX), the default eviction
    strategy. A user who may patch the KubeVirt resource (SelfSubjectAccessReview)
    turns a gate on or off after a confirmation that says what changes,
    flags Alpha features as experimental and lists the VMs that use it;
    Hangar reads the resource fresh and merge-patches only the
    featureGates list with its resourceVersion (retry on conflict), and
    never writes HotplugVolumes with DeclarativeHotplugVolumes. On k4all
    (its API group is served) the gates k4all's ClusterConfig turns on or
    off (the annotations `k4all.magesgate.com/feature-gates` and
    `k4all.magesgate.com/disabled-feature-gates` on the KubeVirt resource:
    the lists have a single manager) are read-only, "Managed by k4all —
    change it in the k4all addon", linked to
    `/k4all/settings/virtualization#feature-gates`; the others Hangar turns
    on and off as before, and k4all keeps them (it removes only its own).
    What k4all's operator applies (`model/ownership.ts`, managedFields,
    manager exactly `k4all-operator`) is read-only too: the VM state
    datastore and software emulation (links to the addon), the release's
    update methods ("set by the k4all release"). Those managedFields come
    from a GET of the KubeVirt resource (`api/managedFields.ts`):
    Headlamp's list hooks delete them from listed objects. cpuModel, evictionStrategy,
    vmRolloutStrategy and the device mappings stay Hangar's.
    Each switch has a row state (`ui/rowState.tsx`, idle → pending → done |
    failed): while the patch runs it shows the asked position and "Turning
    on"; then the state from the object the patch returned, kept
    (`api/kubevirtCopy.ts`, per cluster, the same copy device mappings keep)
    until the polled list has it; a failure puts the switch back and says
    why on the row, with a link to the k4all addon when k4all owns the gate.
  - *Delete protection*: whether the policy and its binding are installed
    (GET on both; "cannot tell" without the right to read them), how to
    install it, the protected VMs.

## 3. Look and feel

A machine room seen through a clean console. Pages are quiet and dense:
Headlamp's theme and font, light and dark, tabular numbers, hairline
panels, one icon set (mdi, bundled offline). The one loud element is the
**faceplate** at the top of a VM page: a dark band drawn like the front
panel of a rack server, with its ears and screws, the live console screen
in a bezel, the status LED, an asset-label strip (guest OS, CPU, memory,
storage, IP, host, folder) and hardware-like buttons (power, restart,
suspend, console) next to the Actions menu. The wizard's step rail and the
product mark reuse the same chassis colour.

Power state is a LED everywhere (tree, lists, faceplate, search), always
with a word next to it: green on, amber suspended, blue pulsing in
transition (no pulse with reduced motion), red error, hollow grey off.
Copy uses the words a virtualization admin uses, sentence case, verbs on
buttons; errors say what happened and how to fix it; destructive actions
confirm and say what is lost (delete asks to type the name).

## 4. Data and operations

- `src/api/data.tsx`: one provider watches the lists (Headlamp's list
  hooks: VMs, VMIs, migrations, nodes, PVCs, DataVolumes, namespaces,
  virt-launcher pods, snapshots, restores) and polls the slow ones
  (StorageClasses, instance types, preferences, StorageProfiles,
  NetworkAttachmentDefinitions, KubeVirt and CDI config) to keep the
  number of WebSockets low. Missing CRDs (404) turn features off (`has`).
  Headlamp (v0.46) deletes `metadata.managedFields` from every listed
  object: whatever reads ownership from them (what k4all owns) GETs the
  single object instead (`src/api/managedFields.ts`).
- `src/api/metrics.ts`: metrics-server, every 15 s while Hangar is open:
  each VM's virt-launcher pod (what the VM really uses on its host) and each
  host; 30 minutes of history in memory.
- `src/api/actions.ts`: every write is a **task** (`runTask`). The API call
  may succeed long before the outcome; a task can carry `until` (the VM is
  on/off/paused/gone, the migration succeeded, the import finished, the
  snapshot is ready, the restore completed), which `useTaskResolver`
  checks against the live objects every 5 s, with a timeout that turns the
  task into "check the target" instead of hanging. Tasks are kept per
  cluster in localStorage.
- VM edits (Configure) are pure functions on a copy (`src/model/edit.ts`)
  applied with a PUT carrying the resourceVersion: a concurrent change is
  refused, not overwritten. KubeVirt decides what applies live and flags
  RestartRequired for the rest.
- Delete protection (`src/model/protection.ts`, `src/api/protection.ts`):
  Configure → Options labels the VM, the dataVolumeTemplates of its disks
  (so disks created later carry it; CDI copies DataVolume labels to the
  PVC) and the existing DataVolumes and PVCs; on, the VM first; off, the
  disks first, so a deletable VM never has undeletable disks its
  deletion would hang on. CD/DVD media (per-VM ISO copies) are not
  protected. The admission policy refuses DELETE of labelled
  VirtualMachines, DataVolumes and PVCs (objectSelector on the old object,
  reason Forbidden). Hangar's delete flows disable delete for protected
  VMs and disks with the reason, bulk delete skips them, removing a disk
  from a protected VM keeps the disk (still protected; Storage → Disks can
  remove its protection), and a disk move labels the new disk and unlabels
  the old one before deleting it.
- Permissions: SelfSubjectAccessReviews (`src/api/permissions.ts`), cached
  5 minutes; actions the user's role does not allow are disabled with the
  reason. `distribution/rbac.yaml` has viewer, VM operator and VM admin
  roles.

### Moving VMs between hosts

`src/model/placement.ts` gives, for a VM and every host, two verdicts with
reasons: **live** (migration while running) and **powered off** (cold
migration). The VMI's `LiveMigratable` condition is the ground truth for
"live at all" and is reworded (`HostDeviceNotLiveMigratable` → "it uses a
device of its host"); per host Hangar adds what KubeVirt checks later:

- CPU: a host-model VM can go where the source's host model is offered for
  migration (`cpu-model-migration.node.kubevirt.io/<model>`) with every
  `host-model-required-features` of the source; an Intel → AMD move is named
  as such. Named models need `cpu-model.node.kubevirt.io/<model>`.
- maintenance (cordon), KubeVirt schedulable label, taints, the VM's node
  selector and affinity, a host pin;
- memory: allocatable minus what VM pods there request (and minus real use
  when metrics-server answers);
- devices (hostDevices, gpus): free units of each resource on the host
  (allocatable minus VM pod limits);
- disks: each PVC's PV node affinity tells which hosts can use it (TopoLVM,
  local PVs: one host, even when the PV says RWX), RWX without host
  affinity is shared, RWO without it is "network, one host at a time".

Live migration posts a VirtualMachineInstanceMigration (with
`addedNodeSelector` for a chosen host); its phase becomes the task's words
("Copying memory to the target host"). A powered-off move pins the VM to the
host (required node affinity) and restarts it; the task waits until it runs
there (`vmOnHost`), then Hangar lifts the pin (KubeVirt applies that live,
no restart) unless the user chose to keep the VM on that host. A VM that is
off keeps the pin until it starts. Free memory counts every pod's requests
on the host as the scheduler does (sidecar init containers, overhead), read
once when the dialog opens; without the right to list pods, VM pods only. Maintenance mode shows
the plan first: VMs that leave live and where, the others with the reason,
and optionally moves those powered off.

Disks move between datastores (`src/model/move.ts`, `src/api/move.ts`):
live with KubeVirt's volume migration (a blank DataVolume on the target,
then the VM's volume points at it with `updateVolumesStrategy: Migration`;
it needs the `LiveMigrate` workload update method in the KubeVirt CR), or
powered off with a CDI clone that the VM uses once it is complete. The new
DataVolume is owned by the VM and replaces the old `dataVolumeTemplates`
entry; the old disk is deleted after the switch when asked. The move is a
staged task (`diskMove`: copy → switch → cleanup) that the task resolver
advances, so it continues after a reload from any open Hangar page. The
end of a live switch is the VolumesChange condition going away: KubeVirt
keeps `volumeMigrationState.migratedVolumes` afterwards. Datastore
pickers say how far disks reach (shared, network, local) and with more than
one host offer a shared datastore first. Ceph pools (Rook) show cluster
health and usable space after replication.

## 5. Code layout

```
plugin/
  scripts/gen-icons.mjs      bundles the mdi icons the sources use (prebuild)
  src/index.tsx              registrations: sidebar entry, the route
  src/shell/                 HangarApp (layout), TopBar, Inventory, TasksDock, nav, settings
  src/views/                 dashboard, vms, vm (page, faceplate, tabs, dialogs, options,
                             devices, shared folders), hosts, storage (datastores, disks,
                             templates), library (images), networks, tasks, settings (features,
                             delete protection)
  src/wizard/                New VM wizard and its catalog (OS, size profiles, images)
  src/console/               VNC and serial consoles, screenshots, console windows
  src/api/                   resources, client, data provider, actions, metrics, guest
                             agent, permissions
  src/model/                 pure logic with unit tests: vm, vmspec, edit, vmoptions
                             (options, devices, CPU, disk settings, shares, hot-add),
                             gates (feature gate table), protection, tasks, units,
                             ownership (k4all's fields, shared with Cairn), metadata,
                             hardware (inventory, mappings, passthrough edits),
                             inventory, capacity, alarms, ...
  src/ui/                    tokens, LED, kit (panels, meters, …), DataTable, dialogs
distribution/node-agent/     the host agent: DaemonSet, agent.sh (bind, inventory), render.awk (JSON)
distribution/protection-policy.yaml   the delete protection ValidatingAdmissionPolicy
```

```bash
cd plugin
npm ci
npm run lint && npm run tsc && npm test && npm run build   # dist/main.js
```

## 6. Decisions

- Folders are namespaces. A namespace is also the security boundary, which
  matches how teams split VMs; empty folders exist when a namespace has the
  label `hangar.magesgate.com/folder: "true"`.
- Templates are stopped VMs with a label, not a separate kind: they are
  visible to every KubeVirt tool, editable like a VM, and new VMs are
  copies (CDI clones), which needs no snapshot support.
- Clones copy disks with CDI DataVolumes (`source.pvc`), not the
  VirtualMachineClone API, which needs volume snapshots. The source must be
  off for a consistent copy (CDI also refuses a PVC in use).
- NAT (masquerade) adapters get a fixed MAC when Hangar makes them (wizard,
  clone, Add adapter): `02:` (locally administered, unicast) and five random
  bytes, new for each copy. Without `macAddress` KubeVirt draws a new MAC at
  every start, and a Linux guest on a persistent disk then sees a new NIC
  and can lose its network settings. Only NAT adapters: their MAC lives on
  the private link between the guest and its own pod, so it never meets
  another VM's. Bridged and SR-IOV adapters sit on a real network, where a
  MAC picked at random could collide and is the user's (or the network
  team's) call: Hangar leaves it unset and a clone drops the source's.
- ISOs are copied per VM (a DataVolume cloned from the library), so any
  host can mount them and nothing is shared across hosts.
- The library namespace is shared with every folder through a Role on
  `datavolumes/source` bound to all service accounts and authenticated
  users: without it CDI refuses to clone a library image into another
  namespace (found in testing).
- No custom font: Headlamp's font keeps the plugin at home in Headlamp and
  air-gap friendly.
- Published ports select KubeVirt's `vmi.kubevirt.io/id` label, which every
  virt-launcher pod carries from KubeVirt v1.7 (the VMI name, hashed past 63
  characters; v1.9.1 `pkg/virt-controller/services/template.go:1739`,
  `pkg/apimachinery/labels.go`), not `vm.kubevirt.io/name` (deprecated, the
  pod's hostname: `spec.hostname` when the VM sets one) nor
  `kubevirt.io/domain` (a pod annotation). Before v1.7 Hangar adds its own
  template label `hangar.magesgate.com/vm`, which reaches the pod at the
  next start. A launcher pod's VM is its owner (the VMI), for the same
  reason.

## 7. Known limits

- CPU models across makers: a VM with a named model both makers offer
  (e.g. SandyBridge) moves live between Intel and AMD hosts — tested on a
  mixed cluster, Intel → AMD → Intel, guest healthy — but QEMU does not officially
  support it and the guest keeps the maker it booted with. Host model and
  host passthrough move live only within a maker (host passthrough only
  between identical CPUs).
- Editing a flavor changes new VMs only: KubeVirt keeps, per VM, a copy of
  the flavor it was sized with.
- KubeVirt allows one console client per VM: a new console (window, tab,
  another user) takes over the previous one.
- "Type text" types for a US keyboard layout in the guest.
- Clipboard sharing needs spice-vdagent in the guest and an unlocked
  desktop session (a locked screen or the login screen has no agent), the
  KubeVirt `Sidecar` feature gate (cluster-wide: anyone who may edit VMs can
  then add hook sidecars) and a restart of the VM. Text only. On plain http
  the browser lets Hangar write this computer's clipboard only right after
  a key press or click.
- Uploads go from the browser straight to CDI's upload proxy: the browser
  must trust its certificate (a self-signed one must be accepted once) and
  stay open until the upload ends.
- A revert that first shuts the VM down runs in the browser: closing it
  midway leaves the VM off without reverting.
- Published ports: Hangar cannot see the guest's firewall; the guest must
  listen on the port and allow it. Who announces a LoadBalancer address
  needs reading MetalLB's `servicel2statuses` or Cilium's leases in
  kube-system, which Hangar's roles do not grant (MetalLB's `nodeAssigned`
  Event covers its first hour). Port ranges are one Service entry each (a
  Service has no ranges), at most 100 at a time. SCTP is not in KubeVirt's
  port list. A web address carries HTTP to the guest (TLS ends at the
  ingress); removing it keeps the port inside the cluster. cert-manager
  keeps a web address's certificate Secret after the Ingress goes unless it
  runs with `--enable-certificate-owner-ref`.
- With Cilium, its `cni-exclusive` setting disables Multus: networks
  can be created but VMs get no secondary NIC until it is turned off.
- With Cilium's kube-proxy replacement, VMs on the pod network
  reach no ClusterIP (so no DNS) unless Cilium runs with
  `socketLB.hostNamespaceOnly: true` (Cilium's setting for KubeVirt).
- A guest gets DNS servers and search domains by DHCP, not resolver options
  (ndots): those stay in the VM's pod.

- VMs with host devices (PCI, GPU, USB) cannot move while running: KubeVirt
  refuses. They move powered off, to a host with a free device of the same
  kind.
- Live migration between hosts with different CPU makers is impossible;
  powered off the VM gets the new host's CPU model.
- Disk moves and the pin lift after a powered-off move run in the browser:
  with no Hangar page open they wait (the disk move resumes when one opens;
  a pin not lifted stays, visible in Configure → Policies).
- KubeVirt hands out identical devices of a host as a pool (one mapping
  per vendor:device id): you choose which physical devices a host offers,
  not which one a VM gets. To reserve one device for one VM, give only
  that one to VMs on its host and pin the VM there.
- KubeVirt's device plugin lists a host's devices when it starts: after a
  device changes sides Hangar restarts KubeVirt's agent on that host
  (virt-handler; running VMs are not affected). If the page closes before
  that step, the Hardware tab offers Reload devices.
- Devices bound by the agent stay with vfio-pci at boot through a udev
  rule; a driver built into the host's initramfs can still grab one first,
  then the agent rebinds it and KubeVirt needs a reload (the Hardware tab
  says so).

- Hot-plug: KubeVirt skips declarative hot-plug while a VM has
  `updateVolumesStrategy: Migration` (left by a live disk move): Hangar's
  hot-plug edits put the default back. CD/DVD media go into a running VM
  only through an empty drive that existed at power-on (KubeVirt cannot add
  a drive live); SATA disks cannot be hot-plugged. KubeVirt keeps a disk it
  created after the disk leaves the VM (owned by the VM): Hangar deletes it
  when asked, or drops the ownership to keep it.
- Hot-added CPUs reach the guest at once, but some Linux guests (Fedora
  cloud images) leave them offline until `echo 1 >
  /sys/devices/system/cpu/cpuN/online`; hot-added memory (virtio-mem) is
  onlined by the guest. The CPU and memory dialog writes only what changed:
  any other template change (even the BIOS default) makes KubeVirt ask for
  a restart and skip the hot-add.
- Persistent UEFI/TPM state on an RWO datastore does not stop live moves:
  KubeVirt v1.7 copies it to a new disk for the target host (tested).
- CPU and memory hot-add need the VM to move live (KubeVirt migrates it to
  resize it): VMs on single-host disks or with host devices grow at their
  next restart. Only sockets can be added; memory needs at least 1 GiB,
  goes in 2 MiB blocks, and cannot go below the size at power-on while
  running.
- Feature gate maturity is known per KubeVirt minor version (v1.7 to v1.10,
  `src/model/gateTables.ts`); a newer KubeVirt shows "maturity unknown"
  until the table gains it.
- vGPU display options apply to mediated devices only and were not tried on
  a real vGPU.
- KubeVirt before v1.8.4 draws a VM's VSOCK CID from the whole 32-bit range
  while its VMI schema accepts int32 only: on recent Kubernetes about one
  power-on in two of a VSOCK VM stays in Starting (kubevirt#17688, fixed in
  v1.8.4 and v1.9). Configure → Devices says so on those versions; powering
  the VM off and on again draws a new CID.
- A VM with shared folders that is stuck before running cannot be powered
  off with a grace period (KubeVirt's VMI update webhook refuses the patch:
  "volume … doesn't have a matching disk", kubevirt#19522, fix pending);
  setting its power policy to Off stops it.
- Feature gates: from KubeVirt v1.9 Beta gates are on unless listed in
  disabledFeatureGates; Hangar turns a Beta gate off there (and writes
  disabledFeatureGates only on v1.8 and later). Tables for v1.7 to v1.10.

## 8. Later

- NIC hot-plug through the GA HotplugNICs feature (Hangar edits the spec;
  KubeVirt plugs bridged adapters in live, Hangar does not say so yet).
- Export a VM or a disk (VirtualMachineExport) and import from other
  virtualizers (CDI's VDDK / oVirt / OpenStack populators).
- Folder quotas (ResourceQuota) shown as folder capacity.
- VM–VM affinity rules ("keep apart", "keep together") as DRS-like groups.
- Translations (Italian first) through Headlamp's i18n.
- A current-state signal for k4all's metadata warnings that is not a
  Secret (e.g. a condition or an annotation on the VM, written and cleared
  by the operator), so the VM summary need not read Events as history: to
  decide with k4all.
