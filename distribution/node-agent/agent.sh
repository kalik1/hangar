#!/bin/sh
# Hangar node agent.
#
# Prepares PCI devices for VMs (binds them to vfio-pci, which KubeVirt
# needs before it can pass them through) and publishes the host's
# hardware as JSON for Hangar: PCI devices, SR-IOV and mediated devices,
# USB devices, disks, which VM holds which device, and what the host
# itself needs. The JSON is served read-only by the pod's httpd container;
# Hangar reads it through the API server (pods/proxy).
#
# Desired state: the file /config/<node name> (ConfigMap
# hangar-system/hangar-passthrough, one key per host), one PCI address per
# line. Hangar writes it; this agent reconciles both ways, at start and
# when the file changes, and keeps a udev rule so the bindings survive a
# reboot. It only gives back to the host the devices it bound itself.
#
#   agent.sh run        reconcile and publish, forever (the DaemonSet)
#   agent.sh gather     print the inventory once (no changes to the host)
#   agent.sh reconcile  apply the desired state once
#
# busybox sh; paths can be overridden for tests (HOST_SYS, HOST_PROC...).
set -u

VERSION=1
NODE=${NODE_NAME:-$(hostname)}
SYS=${HOST_SYS:-/host/sys}
DEV=${HOST_DEV:-/host/dev}
PROC=${HOST_PROC:-/proc}
CONF=${CONF_DIR:-/config}
STATE=${STATE_DIR:-/host/var/lib/hangar}
RULES=${RULES_FILE:-/host/etc/udev/rules.d/60-hangar-vfio.rules}
OUT=${OUT_DIR:-/run/hangar}
IDS=${IDS_DIR:-/hwdata}
AWK=${RENDER_AWK:-/scripts/render.awk}
T=${WORK_DIR:-$OUT/.work}
US=$(printf '\037')

mkdir -p "$OUT" "$T" 2>/dev/null
[ "${1:-}" = gather ] || mkdir -p "$STATE" 2>/dev/null
touch "$STATE/managed" 2>/dev/null

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# rd FILE: first line of FILE into $RV (empty if missing). No fork.
RV=
rd() {
  RV=
  [ -r "$1" ] && read -r RV <"$1" 2>/dev/null
  return 0
}

# Name of the driver bound to a sysfs device dir, or empty.
drvname() {
  l=$(readlink "$1/driver" 2>/dev/null) || l=
  echo "${l##*/}"
}

# PCI addresses in a sysfs path, outermost first.
pci_in_path() {
  _p=$1
  _old=$IFS
  IFS=/
  set -f
  for _c in $_p; do
    case $_c in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f].[0-7]) echo "$_c" ;;
    esac
  done
  set +f
  IFS=$_old
}

rec() {
  # rec FIELD... : one record line, fields joined by the unit separator.
  _first=1
  for _f in "$@"; do
    if [ $_first = 1 ]; then printf '%s' "$_f"; _first=0; else printf '%s%s' "$US" "$_f"; fi
  done
  printf '\n'
}

# ------------------------------------------------------------ host needs

# What the host itself uses: controllers of disks in use, NICs that carry
# its addresses, and everything sharing an IOMMU group with those.
host_needs() {
  open_disks
  : >"$T/needs.raw"
  # Disks in use (partitions, holders, mounts, swap): their controllers.
  for b in "$SYS"/block/*; do
    n=${b##*/}
    case $n in loop* | ram* | zram* | dm-* | md* | nbd* | fd* | sr* | rbd* | drbd* | zd*) continue ;; esac
    used=
    for p in "$b"/"$n"*; do [ -f "$p/partition" ] && used=1 && break; done
    [ -z "$used" ] && [ -n "$(ls "$b/holders" 2>/dev/null)" ] && used=1
    [ -z "$used" ] && grep -q "^/dev/$n[ 0-9p]" "$PROC/1/mounts" 2>/dev/null && used=1
    [ -z "$used" ] && grep -q "^/dev/$n[ 0-9p]" "$PROC/swaps" 2>/dev/null && used=1
    [ -z "$used" ] && [ -n "$(signature "$n")" ] && used=1
    [ -z "$used" ] && [ -n "$(openers "$n")" ] && used=1
    [ -n "$used" ] || continue
    for a in $(pci_in_path "$(readlink -f "$b")"); do rec "$a" "controls the host's disk $n" >>"$T/needs.raw"; done
  done
  # Interfaces with routes, then down to the physical ports.
  {
    awk 'NR>1 && $1!="lo" {print $1}' "$PROC/1/net/route" 2>/dev/null
    awk '$NF!="lo" {print $NF}' "$PROC/1/net/ipv6_route" 2>/dev/null
  } | sort -u >"$T/ifs.todo"
  : >"$T/ifs.seen"
  i=0
  while [ -s "$T/ifs.todo" ] && [ $i -lt 6 ]; do
    i=$((i + 1))
    : >"$T/ifs.next"
    while read -r ifc; do
      grep -qx "$ifc" "$T/ifs.seen" && continue
      echo "$ifc" >>"$T/ifs.seen"
      nd="$SYS/class/net/$ifc"
      [ -e "$nd" ] || continue
      if [ -e "$nd/device" ]; then
        for a in $(pci_in_path "$(readlink -f "$nd/device")"); do rec "$a" "carries the host's network ($ifc)" >>"$T/needs.raw"; done
        continue
      fi
      lower=
      for l in "$nd"/lower_*; do [ -e "$l" ] && echo "${l##*/lower_}" >>"$T/ifs.next" && lower=1; done
      for l in "$nd"/brif/*; do [ -e "$l" ] && echo "${l##*/}" >>"$T/ifs.next" && lower=1; done
      # An Open vSwitch port: the physical ports are those of ovs-system.
      if [ -z "$lower" ] && [ -e "$SYS/class/net/ovs-system" ]; then
        for m in "$SYS"/class/net/*/master; do
          [ "$(readlink "$m" 2>/dev/null | sed 's#.*/##')" = ovs-system ] || continue
          m=${m%/master}
          echo "${m##*/}" >>"$T/ifs.next"
        done
      fi
    done <"$T/ifs.todo"
    sort -u "$T/ifs.next" >"$T/ifs.todo"
  done
  # Same IOMMU group as something the host needs: VFIO takes whole groups.
  cut -d"$US" -f1 "$T/needs.raw" | sort -u >"$T/needs.addr"
  while read -r a; do
    g=$(readlink "$SYS/bus/pci/devices/$a/iommu_group" 2>/dev/null) || continue
    g=${g##*/}
    for m in "$SYS"/kernel/iommu_groups/"$g"/devices/*; do
      [ -e "$m" ] || continue
      m=${m##*/}
      [ "$m" = "$a" ] || rec "$m" "shares IOMMU group $g with $a, which the host needs" >>"$T/needs.raw"
    done
  done <"$T/needs.addr"
  # First reason per device.
  awk -F"$US" '!seen[$1]++' "$T/needs.raw" >"$T/needs"
}

# ---------------------------------------------------------- device usage

# Which VM holds which VFIO group and USB device: the qemu processes'
# open files. VM names come from qemu's "-name guest=<namespace>_<name>".
# Block devices host processes hold open ("dev comm" lines), e.g. a Ceph OSD on its raw disk.
open_disks() {
  ls -l "$PROC"/[0-9]*/fd 2>/dev/null | awk '
    /\/fd:$/ { pid = $0; sub(/\/fd:$/, "", pid); sub(/.*\//, "", pid); next }
    / -> \/dev\/(sd|vd|hd|xvd|nvme)[a-z0-9]*$/ { d = $NF; sub(/^\/dev\//, "", d); print pid, d }' | sort -u >"$T/open.raw"
  : >"$T/open"
  while read -r pid dv; do
    rd "$PROC/$pid/comm"
    [ -n "$RV" ] && echo "$dv $RV" >>"$T/open"
  done <"$T/open.raw"
}

# Processes holding disk $1 or one of its partitions, comma separated.
openers() {
  awk -v n="$1" '$1 == n || $1 ~ ("^" n "p?[0-9]+$") {print $2}' "$T/open" 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//'
}

usage() {
  open_disks
  : >"$T/usage"
  for p in "$PROC"/[0-9]*; do
    rd "$p/comm"
    case $RV in qemu* | *kvm*) ;; *) continue ;; esac
    g=$(tr '\0' '\n' <"$p/cmdline" 2>/dev/null | awk 'f {print; exit} $0 == "-name" {f = 1}')
    g=${g#guest=}
    g=${g%%,*}
    [ -n "$g" ] || continue
    vm="${g%%_*}/${g#*_}"
    ls -l "$p/fd" 2>/dev/null | sed -n 's#.* -> /dev/vfio/\([0-9][0-9]*\)$#\1#p' | sort -u | while read -r grp; do
      rec G "$grp" "$vm" >>"$T/usage"
    done
    ls -l "$p/fd" 2>/dev/null | sed -n 's#.* -> /dev/bus/usb/\([0-9]*\)/\([0-9]*\)$#\1 \2#p' | sort -u | while read -r bus dn; do
      rec V "$((1$bus - 1000))" "$((1$dn - 1000))" "$vm" >>"$T/usage"
    done
  done
}

group_holder() {
  # VM holding VFIO group $1, if any.
  awk -F"$US" -v g="$1" '$1 == "G" && $2 == g {print $3; exit}' "$T/usage"
}

# -------------------------------------------------------------- binding

desired_list() {
  f="$CONF/$NODE"
  [ -r "$f" ] || return 0
  { cat "$f"; echo; } | sed 's/#.*//' | tr ', \t' '\n\n\n' | tr 'A-F' 'a-f' | while read -r a; do
    case $a in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f].[0-7]) echo "$a" ;;
    [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f].[0-7]) echo "0000:$a" ;;
    esac
  done | sort -u
}

st() { rec "$1" "$2" "${3:-}" >>"$T/status.new"; }

managed_add() { grep -qx "$1" "$STATE/managed" || echo "$1" >>"$STATE/managed"; }
managed_del() { grep -vx "$1" "$STATE/managed" >"$STATE/managed.tmp"; mv "$STATE/managed.tmp" "$STATE/managed"; }

bind_vfio() {
  a=$1
  d="$SYS/bus/pci/devices/$a"
  [ -e "$d" ] || { st "$a" missing "This device is not on the host."; return; }
  reason=$(awk -F"$US" -v a="$a" '$1 == a {print $2; exit}' "$T/needs")
  [ -z "$reason" ] || { st "$a" refused "Kept for the host: it $reason."; return; }
  cur=$(drvname "$d")
  if [ "$cur" != vfio-pci ]; then
    [ -d "$SYS/bus/pci/drivers/vfio-pci" ] || nsenter -t 1 -m -- modprobe vfio-pci >/dev/null 2>&1 || true
    [ -d "$SYS/bus/pci/drivers/vfio-pci" ] || { st "$a" failed "The vfio-pci driver is not available on this host."; return; }
    echo vfio-pci >"$d/driver_override" 2>/dev/null || { st "$a" failed "The host refused the driver override."; return; }
    [ -z "$cur" ] || echo "$a" >"$d/driver/unbind" 2>/dev/null
    echo "$a" >"$SYS/bus/pci/drivers_probe" 2>/dev/null
    now=$(drvname "$d")
    if [ "$now" != vfio-pci ]; then
      st "$a" failed "The kernel did not bind vfio-pci (driver now: ${now:-none})."
      return
    fi
    date +%s >"$OUT/last-bind"
    log "bound $a to vfio-pci (was ${cur:-no driver})"
  else
    rd "$d/driver_override"
    [ "$RV" = vfio-pci ] || echo vfio-pci >"$d/driver_override" 2>/dev/null
  fi
  managed_add "$a"
  st "$a" ready ""
}

release() {
  a=$1
  d="$SYS/bus/pci/devices/$a"
  if [ ! -e "$d" ]; then managed_del "$a"; return; fi
  g=$(readlink "$d/iommu_group" 2>/dev/null) && g=${g##*/} || g=
  holder=
  [ -n "$g" ] && holder=$(group_holder "$g")
  if [ -n "$holder" ]; then
    st "$a" deferred "In use by $holder: it goes back to the host when that VM powers off."
    return
  fi
  echo >"$d/driver_override" 2>/dev/null
  [ "$(drvname "$d")" = vfio-pci ] && echo "$a" >"$SYS/bus/pci/drivers/vfio-pci/unbind" 2>/dev/null
  echo "$a" >"$SYS/bus/pci/drivers_probe" 2>/dev/null
  managed_del "$a"
  log "gave $a back to the host (driver now: $(drvname "$d"))"
}

write_rules() {
  [ -d "${RULES%/*}" ] || return 0
  if [ ! -s "$STATE/managed" ]; then
    [ -e "$RULES" ] && rm -f "$RULES" && log "removed $RULES"
    return 0
  fi
  {
    echo "# Written by hangar-node-agent: these PCI devices go to vfio-pci at boot, for VMs."
    echo "# Change them from Hangar (host > Hardware); the agent rewrites this file."
    sort -u "$STATE/managed" | while read -r a; do
      [ -n "$a" ] && echo "ACTION==\"add\", SUBSYSTEM==\"pci\", KERNEL==\"$a\", ATTR{driver_override}=\"vfio-pci\", RUN{builtin}+=\"kmod load vfio-pci\""
    done
  } >"$RULES.tmp"
  if cmp -s "$RULES.tmp" "$RULES"; then rm -f "$RULES.tmp"; else mv "$RULES.tmp" "$RULES" && log "wrote $RULES"; fi
}

reconcile() {
  host_needs
  usage
  : >"$T/status.new"
  desired_list >"$T/desired"
  while read -r a; do bind_vfio "$a"; done <"$T/desired"
  sort -u "$STATE/managed" | while read -r a; do
    [ -n "$a" ] || continue
    grep -qx "$a" "$T/desired" || release "$a"
  done
  write_rules
  mv "$T/status.new" "$T/status"
}

# ------------------------------------------------------------- inventory

# What the start of a disk says it holds (comma list), like blkid does.
signature() {
  _d="$DEV/$1"
  [ -b "$_d" ] || return 0
  _s=$(dd if="$_d" bs=4096 count=1 2>/dev/null | tr -c '[:print:]' '.')
  _out=
  case $_s in *"bluestore block device"*) _out="$_out,ceph" ;; esac
  case $_s in *LABELONE*) _out="$_out,lvm" ;; esac
  case $_s in *"EFI PART"*) _out="$_out,gpt" ;; esac
  case $_s in XFSB*) _out="$_out,xfs" ;; esac
  case $_s in LUKS*) _out="$_out,luks" ;; esac
  case $_s in *SWAPSPACE2* | *SWAP-SPACE*) _out="$_out,swap" ;; esac
  [ "$(dd if="$_d" bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' ')" = 53ef ] && _out="$_out,ext"
  [ "$(dd if="$_d" bs=1 skip=65600 count=8 2>/dev/null)" = "_BHRfS_M" ] && _out="$_out,btrfs"
  case $_out in *gpt*) ;; *) [ "$(dd if="$_d" bs=1 skip=510 count=2 2>/dev/null | od -An -tx1 | tr -d ' ')" = 55aa ] && _out="$_out,mbr" ;; esac
  echo "${_out#,}"
}

gather_records() {
  R=$1
  : >"$R"
  rec K node "$NODE" >>"$R"
  rec K agent "$VERSION" >>"$R"
  rec K generated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$R"
  rd "$PROC/cmdline"
  rec K cmdline "$RV" >>"$R"
  rec K kernel "$(uname -r)" >>"$R"
  # firewalld lets in only what it is told: published host ports (NodePorts,
  # 30000-32767) need opening there (hostPID: the host's processes).
  fw=0
  for c in "$PROC"/[0-9]*/comm; do
    rd "$c"
    [ "$RV" = firewalld ] && fw=1 && break
  done
  rec K firewalld "$fw" >>"$R"
  ng=$(ls "$SYS/kernel/iommu_groups" 2>/dev/null | wc -l)
  rec K iommuGroups "$ng" >>"$R"
  [ -d "$SYS/bus/pci/drivers/vfio-pci" ] && rec K vfio 1 >>"$R"
  rd "$OUT/last-bind"
  [ -n "$RV" ] && rec K lastBind "$RV" >>"$R"

  # PCI
  for d in "$SYS"/bus/pci/devices/*; do
    [ -e "$d" ] || continue
    a=${d##*/}
    rd "$d/class"; cls=${RV#0x}
    rd "$d/vendor"; ven=${RV#0x}
    rd "$d/device"; dev=${RV#0x}
    rd "$d/subsystem_vendor"; sv=${RV#0x}
    rd "$d/subsystem_device"; sd=${RV#0x}
    rd "$d/revision"; rev=${RV#0x}
    drv=$(drvname "$d")
    rd "$d/driver_override"; ov=$RV
    [ "$ov" = "(null)" ] && ov=
    g=$(readlink "$d/iommu_group" 2>/dev/null) && g=${g##*/} || g=
    rd "$d/numa_node"; numa=$RV
    rd "$d/sriov_totalvfs"; tvf=$RV
    rd "$d/sriov_numvfs"; nvf=$RV
    pf=$(readlink "$d/physfn" 2>/dev/null) && pf=${pf##*/} || pf=
    rd "$d/boot_vga"; bv=$RV
    par=$(pci_in_path "$(readlink -f "$d")" | tail -2 | head -1)
    [ "$par" = "$a" ] && par=
    rec P "$a" "$cls" "$ven" "$dev" "$sv" "$sd" "$rev" "$drv" "$ov" "$g" "$numa" "$tvf" "$nvf" "$pf" "$bv" "$par" >>"$R"
    for m in "$d"/mdev_supported_types/*; do
      [ -d "$m" ] || continue
      rd "$m/name"; mn=$RV
      rd "$m/available_instances"; av=$RV
      rd "$m/device_api"; api=$RV
      rd "$m/description"; desc=$RV
      rec M "$a" "${m##*/}" "$mn" "$av" "$api" "$desc" >>"$R"
    done
  done
  for m in "$SYS"/bus/mdev/devices/*; do
    [ -e "$m" ] || continue
    u=${m##*/}
    par=$(pci_in_path "$(readlink -f "$m")" | tail -1)
    ty=$(readlink "$m/mdev_type" 2>/dev/null) && ty=${ty##*/} || ty=
    g=$(readlink "$m/iommu_group" 2>/dev/null) && g=${g##*/} || g=
    rec D "$u" "$par" "$ty" "$g" >>"$R"
  done

  # USB (devices, not interfaces or root hubs)
  for u in "$SYS"/bus/usb/devices/*; do
    n=${u##*/}
    case $n in *:* | usb*) continue ;; esac
    [ -f "$u/idVendor" ] || continue
    rd "$u/busnum"; bus=$RV
    rd "$u/devnum"; dn=$RV
    rd "$u/idVendor"; ven=$RV
    rd "$u/idProduct"; prod=$RV
    rd "$u/manufacturer"; man=$RV
    rd "$u/product"; pn=$RV
    rd "$u/serial"; ser=$RV
    rd "$u/speed"; spd=$RV
    rd "$u/bDeviceClass"; dc=$RV
    ifc=
    drvs=
    for i in "$u/$n":*; do
      [ -d "$i" ] || continue
      rd "$i/bInterfaceClass"
      ifc="$ifc${ifc:+,}$RV"
      x=$(drvname "$i")
      [ -n "$x" ] && drvs="$drvs${drvs:+,}$x"
    done
    ctl=$(pci_in_path "$(readlink -f "$u")" | tail -1)
    rec U "$n" "$bus" "$dn" "$ven" "$prod" "$man" "$pn" "$ser" "$spd" "$dc" "$ifc" "$drvs" "$ctl" >>"$R"
  done

  # Disks
  : >"$T/byid"
  for l in "$DEV"/disk/by-id/*; do
    [ -L "$l" ] || continue
    t=$(readlink "$l")
    rec "${t##*/}" "${l##*/}" >>"$T/byid"
  done
  for b in "$SYS"/block/*; do
    n=${b##*/}
    case $n in loop* | ram* | zram* | dm-* | md* | nbd* | fd* | rbd* | drbd* | zd*) continue ;; esac
    rd "$b/size"; size=$((${RV:-0} * 512))
    rd "$b/device/model"; model=$RV
    rd "$b/device/vendor"; vend=$RV
    rd "$b/device/serial"; ser=$RV
    rd "$b/device/wwid"; wwid=$RV
    [ -n "$wwid" ] || { rd "$b/wwid"; wwid=$RV; }
    rd "$b/queue/rotational"; rot=$RV
    rd "$b/removable"; rem=$RV
    ids=$(awk -F"$US" -v n="$n" '$1 == n {print $2}' "$T/byid" | tr '\n' ',' | sed 's/,$//')
    parts=
    holders=$(ls "$b/holders" 2>/dev/null | tr '\n' ',')
    for p in "$b"/"$n"*; do
      [ -f "$p/partition" ] || continue
      parts="$parts${parts:+,}${p##*/}"
      h=$(ls "$p/holders" 2>/dev/null | tr '\n' ',')
      holders="$holders$h"
    done
    holders=${holders%,}
    mounts=$(awk -v n="$n" '$1 ~ "^/dev/" n "([0-9]|p[0-9]|$)" {print $2}' "$PROC/1/mounts" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
    swap=$(awk -v n="$n" '$1 ~ "^/dev/" n "([0-9]|p[0-9]|$)" {print "swap"}' "$PROC/swaps" 2>/dev/null | head -1)
    path=$(readlink -f "$b")
    ctl=$(pci_in_path "$path" | tail -1)
    case $path in
    */nvme/*) tr=nvme ;;
    */usb[0-9]*) tr=usb ;;
    */end_device-* | */port-*) tr=sas ;;
    */ata[0-9]*) tr=sata ;;
    */virtio[0-9]*) tr=virtio ;;
    *) tr=scsi ;;
    esac
    case $n in sr*) tr=cdrom ;; esac
    sig=
    case $tr in cdrom) ;; *) sig=$(signature "$n") ;; esac
    rec B "$n" "$size" "$model" "$vend" "$ser" "$wwid" "$rot" "$rem" "$ids" "$parts" "$holders" "${mounts}${swap:+${mounts:+,}$swap}" "$ctl" "$tr" "$sig" "$(openers "$n")" >>"$R"
  done

  # What the host needs, who uses what, the binder's view.
  sed "s/^/H$US/" "$T/needs" >>"$R" 2>/dev/null
  cat "$T/usage" >>"$R" 2>/dev/null
  sed "s/^/S$US/" "$T/status" >>"$R" 2>/dev/null
  while read -r a; do [ -n "$a" ] && rec W "$a" >>"$R"; done <"$T/desired" 2>/dev/null
  [ -r "$STATE/managed" ] && while read -r a; do [ -n "$a" ] && rec X "$a" >>"$R"; done <"$STATE/managed"
}

render() {
  awk -F"$US" -v rec="$1" -f "$AWK" "$1" "$IDS/pci.ids" "$IDS/usb.ids"
}

publish() {
  gather_records "$T/records" || return
  render "$T/records" >"$OUT/inventory.json.tmp" 2>"$T/render.err" && mv "$OUT/inventory.json.tmp" "$OUT/inventory.json"
}

case ${1:-run} in
gather)
  [ -s "$T/needs" ] || host_needs
  usage
  : >>"$T/status"
  : >>"$T/desired"
  gather_records "$T/records"
  render "$T/records"
  ;;
reconcile)
  reconcile
  cat "$T/status"
  ;;
run)
  log "hangar-node-agent $VERSION on $NODE"
  last=
  n=0
  while :; do
    sum=$(cat "$CONF/$NODE" 2>/dev/null | md5sum)
    if [ "$sum" != "$last" ] || [ $((n % 12)) -eq 0 ]; then
      reconcile
      last=$sum
      publish
    elif [ $((n % 4)) -eq 0 ]; then
      usage
      publish
    fi
    n=$((n + 1))
    sleep 5
  done
  ;;
*)
  echo "usage: $0 run|gather|reconcile" >&2
  exit 2
  ;;
esac
