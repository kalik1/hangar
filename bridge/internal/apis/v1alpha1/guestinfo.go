package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The sections of a GuestInfo: the values of the guestinfo call's
// "sections" parameter, and the names of the answer's blocks.
const (
	SectionSystem  = "system"
	SectionCPU     = "cpu"
	SectionMemory  = "memory"
	SectionDisks   = "disks"
	SectionNetwork = "network"
	SectionUsers   = "users"
	SectionDevices = "devices"
	SectionSSHKeys = "sshkeys"
	SectionTime    = "time"
)

// Sections are every section, in the answer's order. A guestinfo call
// without "sections" reads them all.
var Sections = []string{
	SectionSystem, SectionCPU, SectionMemory, SectionDisks, SectionNetwork,
	SectionUsers, SectionDevices, SectionSSHKeys, SectionTime,
}

// The reasons of GuestInfoError.
const (
	// ReasonBlocked: the guest's agent configuration disables the command
	// (qemu-ga --allow-rpcs or --block-rpcs). It is never called.
	ReasonBlocked = "Blocked"
	// ReasonNotSupported: this agent has no such command, for its version or
	// its OS.
	ReasonNotSupported = "NotSupported"
	// ReasonTimeout: the agent did not answer the command in time.
	ReasonTimeout = "Timeout"
	// ReasonAgentError: the agent ran the command and it failed, for
	// example a permission denied in a guest whose SELinux policy confines
	// the agent.
	ReasonAgentError = "AgentError"
	// ReasonNotResponding: the agent does not answer at all, or libvirt
	// marked it broken. Restarting qemu-guest-agent in the guest fixes it;
	// until then the bridge pings it once per 30 s and calls nothing else.
	ReasonNotResponding = "NotResponding"
)

// GuestInfo is the answer of GET .../virtualmachineinstances/{name}/guestinfo:
// what the VM's guest agent reports, read by the bridge from the agent's
// read-only commands.
//
// Each section block mirrors the agent's replies (see the QEMU Guest Agent
// Protocol Reference), with the agent's field names in camelCase. A block is
// present when at least one of its commands answered; what did not answer is
// in Errors.
type GuestInfo struct {
	metav1.TypeMeta `json:",inline"`

	Agent GuestAgent `json:"agent"`

	System  *GuestSystem  `json:"system,omitempty"`
	CPU     *GuestCPU     `json:"cpu,omitempty"`
	Memory  *GuestMemory  `json:"memory,omitempty"`
	Disks   *GuestDisks   `json:"disks,omitempty"`
	Network *GuestNetwork `json:"network,omitempty"`
	Users   *GuestUsers   `json:"users,omitempty"`
	Devices *GuestDevices `json:"devices,omitempty"`
	SSHKeys *GuestSSHKeys `json:"sshkeys,omitempty"`
	Time    *GuestTime    `json:"time,omitempty"`

	// Errors are the commands of the requested sections that gave no
	// answer, and why.
	Errors []GuestInfoError `json:"errors,omitempty"`

	// ReadAt is when the bridge read the agent.
	ReadAt metav1.Time `json:"readAt"`
}

// GuestAgent is the agent's state, from the bridge's own calls. It never
// comes from KubeVirt's AgentConnected condition, which stays True on a
// broken agent.
type GuestAgent struct {
	// Connected is false when no agent answers on the VM's channel: it is
	// not installed or not running, or the VM is not running.
	Connected bool `json:"connected"`
	// Healthy is false when the agent is connected but does not respond.
	Healthy bool `json:"healthy"`
	// Version is the agent's version, from guest-info.
	Version string `json:"version,omitempty"`
	// Commands are the agent's commands, from guest-info, with their state:
	// a command the guest's configuration blocks is not enabled.
	Commands []GuestAgentCommand `json:"commands,omitempty"`
	// Message says why the agent is not connected or not healthy.
	Message string `json:"message,omitempty"`
}

// GuestAgentCommand is one command of guest-info.
type GuestAgentCommand struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

// GuestInfoError is one command that gave no answer.
type GuestInfoError struct {
	// Section is the section the command is for.
	Section string `json:"section"`
	// Command is the agent command, such as guest-get-users.
	Command string `json:"command,omitempty"`
	// Reason is one of Blocked, NotSupported, Timeout, AgentError and
	// NotResponding.
	Reason string `json:"reason"`
	// Message is for people.
	Message string `json:"message"`
}

// GuestSystem is the section "system": guest-get-osinfo,
// guest-get-host-name and guest-get-timezone.
type GuestSystem struct {
	OS       *GuestOSInfo   `json:"os,omitempty"`
	HostName string         `json:"hostName,omitempty"`
	Timezone *GuestTimezone `json:"timezone,omitempty"`
}

// GuestOSInfo is guest-get-osinfo. ID is "mswindows" on Windows.
type GuestOSInfo struct {
	KernelRelease string `json:"kernelRelease,omitempty"`
	KernelVersion string `json:"kernelVersion,omitempty"`
	Machine       string `json:"machine,omitempty"`
	ID            string `json:"id,omitempty"`
	Name          string `json:"name,omitempty"`
	PrettyName    string `json:"prettyName,omitempty"`
	Version       string `json:"version,omitempty"`
	VersionID     string `json:"versionId,omitempty"`
	Variant       string `json:"variant,omitempty"`
	VariantID     string `json:"variantId,omitempty"`
}

// GuestTimezone is guest-get-timezone. Offset is in seconds east of UTC.
type GuestTimezone struct {
	Zone   string `json:"zone,omitempty"`
	Offset int64  `json:"offset"`
}

// GuestCPU is the section "cpu": guest-get-vcpus, guest-get-cpustats
// (Linux) and guest-get-load (qemu-ga 10.0 and later).
type GuestCPU struct {
	VCPUs []GuestLogicalProcessor `json:"vcpus,omitempty"`
	Stats []GuestCPUStats         `json:"stats,omitempty"`
	Load  *GuestLoadAverage       `json:"load,omitempty"`
}

// GuestLogicalProcessor is one entry of guest-get-vcpus.
type GuestLogicalProcessor struct {
	LogicalID  int64 `json:"logicalId"`
	Online     bool  `json:"online"`
	CanOffline *bool `json:"canOffline,omitempty"`
}

// GuestCPUStats is one entry of guest-get-cpustats: the CPU's times, in
// the guest's clock ticks (USER_HZ), since the guest booted. Type is
// "linux", the only type the agent has.
type GuestCPUStats struct {
	Type      string  `json:"type"`
	CPU       int64   `json:"cpu"`
	User      uint64  `json:"user"`
	Nice      uint64  `json:"nice"`
	System    uint64  `json:"system"`
	Idle      uint64  `json:"idle"`
	IOWait    *uint64 `json:"iowait,omitempty"`
	IRQ       *uint64 `json:"irq,omitempty"`
	SoftIRQ   *uint64 `json:"softirq,omitempty"`
	Steal     *uint64 `json:"steal,omitempty"`
	Guest     *uint64 `json:"guest,omitempty"`
	GuestNice *uint64 `json:"guestnice,omitempty"`
}

// GuestLoadAverage is guest-get-load.
type GuestLoadAverage struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}

// GuestMemory is the section "memory": guest-get-memory-blocks (Linux).
type GuestMemory struct {
	Blocks []GuestMemoryBlock `json:"blocks,omitempty"`
}

// GuestMemoryBlock is one entry of guest-get-memory-blocks.
type GuestMemoryBlock struct {
	PhysIndex  uint64 `json:"physIndex"`
	Online     bool   `json:"online"`
	CanOffline *bool  `json:"canOffline,omitempty"`
}

// GuestDisks is the section "disks": guest-get-disks, guest-get-diskstats
// (Linux) and guest-get-fsinfo.
type GuestDisks struct {
	Disks       []GuestDiskInfo       `json:"disks,omitempty"`
	Stats       []GuestDiskStatsInfo  `json:"stats,omitempty"`
	Filesystems []GuestFilesystemInfo `json:"filesystems,omitempty"`
}

// GuestDiskInfo is one entry of guest-get-disks: a disk or a partition,
// with the address that matches it to the VM's disk.
type GuestDiskInfo struct {
	Name         string            `json:"name"`
	Partition    bool              `json:"partition"`
	Dependencies []string          `json:"dependencies,omitempty"`
	Address      *GuestDiskAddress `json:"address,omitempty"`
	Alias        string            `json:"alias,omitempty"`
}

// GuestDiskAddress is a disk's address as the guest sees it. Serial matches
// the VM's disk serial.
type GuestDiskAddress struct {
	PCIController GuestPCIAddress  `json:"pciController"`
	BusType       string           `json:"busType"`
	Bus           int64            `json:"bus"`
	Target        int64            `json:"target"`
	Unit          int64            `json:"unit"`
	Serial        string           `json:"serial,omitempty"`
	Dev           string           `json:"dev,omitempty"`
	CCWAddress    *GuestCCWAddress `json:"ccwAddress,omitempty"`
}

// GuestPCIAddress is a PCI address.
type GuestPCIAddress struct {
	Domain   int64 `json:"domain"`
	Bus      int64 `json:"bus"`
	Slot     int64 `json:"slot"`
	Function int64 `json:"function"`
}

// GuestCCWAddress is an s390 CCW address.
type GuestCCWAddress struct {
	CSSID   int64 `json:"cssid"`
	SSID    int64 `json:"ssid"`
	SubchNo int64 `json:"subchno"`
	DevNo   int64 `json:"devno"`
}

// GuestDiskStatsInfo is one entry of guest-get-diskstats.
type GuestDiskStatsInfo struct {
	Name  string         `json:"name"`
	Major int64          `json:"major"`
	Minor int64          `json:"minor"`
	Stats GuestDiskStats `json:"stats"`
}

// GuestDiskStats are a block device's I/O counters, as in
// /proc/diskstats. Ticks are milliseconds.
type GuestDiskStats struct {
	ReadSectors    *uint64 `json:"readSectors,omitempty"`
	ReadIOs        *uint64 `json:"readIos,omitempty"`
	ReadMerges     *uint64 `json:"readMerges,omitempty"`
	WriteSectors   *uint64 `json:"writeSectors,omitempty"`
	WriteIOs       *uint64 `json:"writeIos,omitempty"`
	WriteMerges    *uint64 `json:"writeMerges,omitempty"`
	DiscardSectors *uint64 `json:"discardSectors,omitempty"`
	DiscardIOs     *uint64 `json:"discardIos,omitempty"`
	DiscardMerges  *uint64 `json:"discardMerges,omitempty"`
	FlushIOs       *uint64 `json:"flushIos,omitempty"`
	ReadTicks      *uint64 `json:"readTicks,omitempty"`
	WriteTicks     *uint64 `json:"writeTicks,omitempty"`
	DiscardTicks   *uint64 `json:"discardTicks,omitempty"`
	FlushTicks     *uint64 `json:"flushTicks,omitempty"`
	IOsPending     *uint64 `json:"iosPending,omitempty"`
	TotalTicks     *uint64 `json:"totalTicks,omitempty"`
	WeightTicks    *uint64 `json:"weightTicks,omitempty"`
}

// GuestFilesystemInfo is one entry of guest-get-fsinfo: a mounted
// filesystem, its usage, and the disks under it.
type GuestFilesystemInfo struct {
	Name                 string             `json:"name"`
	Mountpoint           string             `json:"mountpoint"`
	Type                 string             `json:"type"`
	UsedBytes            *uint64            `json:"usedBytes,omitempty"`
	TotalBytes           *uint64            `json:"totalBytes,omitempty"`
	TotalBytesPrivileged *uint64            `json:"totalBytesPrivileged,omitempty"`
	Disk                 []GuestDiskAddress `json:"disk,omitempty"`
}

// GuestNetwork is the section "network": guest-network-get-interfaces and
// guest-network-get-route (Linux, qemu-ga 9.1 and later).
type GuestNetwork struct {
	Interfaces []GuestNetworkInterface `json:"interfaces,omitempty"`
	Routes     []GuestNetworkRoute     `json:"routes,omitempty"`
}

// GuestNetworkInterface is one entry of guest-network-get-interfaces.
// HardwareAddress matches the VM's NIC by MAC.
type GuestNetworkInterface struct {
	Name            string                     `json:"name"`
	HardwareAddress string                     `json:"hardwareAddress,omitempty"`
	IPAddresses     []GuestIPAddress           `json:"ipAddresses,omitempty"`
	Statistics      *GuestNetworkInterfaceStat `json:"statistics,omitempty"`
}

// GuestIPAddress is an interface address. IPAddressType is "ipv4" or
// "ipv6".
type GuestIPAddress struct {
	IPAddress     string `json:"ipAddress"`
	IPAddressType string `json:"ipAddressType"`
	Prefix        int64  `json:"prefix"`
}

// GuestNetworkInterfaceStat are an interface's counters.
type GuestNetworkInterfaceStat struct {
	RxBytes   uint64 `json:"rxBytes"`
	RxPackets uint64 `json:"rxPackets"`
	RxErrs    uint64 `json:"rxErrs"`
	RxDropped uint64 `json:"rxDropped"`
	TxBytes   uint64 `json:"txBytes"`
	TxPackets uint64 `json:"txPackets"`
	TxErrs    uint64 `json:"txErrs"`
	TxDropped uint64 `json:"txDropped"`
}

// GuestNetworkRoute is one entry of guest-network-get-route. Version is 4
// or 6; the IPv4 and IPv6 fields are set for their version only.
type GuestNetworkRoute struct {
	Iface        string `json:"iface"`
	Destination  string `json:"destination"`
	Metric       int64  `json:"metric"`
	Version      int64  `json:"version"`
	Gateway      string `json:"gateway,omitempty"`
	Mask         string `json:"mask,omitempty"`
	IRTT         *int64 `json:"irtt,omitempty"`
	Flags        *int64 `json:"flags,omitempty"`
	RefCnt       *int64 `json:"refcnt,omitempty"`
	Use          *int64 `json:"use,omitempty"`
	Window       *int64 `json:"window,omitempty"`
	MTU          *int64 `json:"mtu,omitempty"`
	DesPrefixLen string `json:"desprefixlen,omitempty"`
	Source       string `json:"source,omitempty"`
	SrcPrefixLen string `json:"srcprefixlen,omitempty"`
	NextHop      string `json:"nexthop,omitempty"`
}

// GuestUsers is the section "users": guest-get-users, the users logged in.
type GuestUsers struct {
	Items []GuestUser `json:"items"`
}

// GuestUser is one logged-in user. LoginTime is in seconds since the Unix
// epoch; Domain is set on Windows.
type GuestUser struct {
	User      string  `json:"user"`
	Domain    string  `json:"domain,omitempty"`
	LoginTime float64 `json:"loginTime"`
}

// GuestDevices is the section "devices": guest-get-devices (Windows), the
// devices and their drivers.
type GuestDevices struct {
	Items []GuestDeviceInfo `json:"items"`
}

// GuestDeviceInfo is one device. DriverDate is in nanoseconds since the
// Unix epoch.
type GuestDeviceInfo struct {
	DriverName    string         `json:"driverName"`
	DriverDate    *int64         `json:"driverDate,omitempty"`
	DriverVersion string         `json:"driverVersion,omitempty"`
	ID            *GuestDeviceID `json:"id,omitempty"`
}

// GuestDeviceID is a device's ID. Type is "pci", the only type the agent
// has.
type GuestDeviceID struct {
	Type     string `json:"type"`
	VendorID int64  `json:"vendorId"`
	DeviceID int64  `json:"deviceId"`
}

// GuestSSHKeys is the section "sshkeys": guest-ssh-get-authorized-keys, read
// only, for root (not on Windows), the users the call names in its
// "sshUsers" parameter (at most 4, such as the VM's cloud-init user), and
// the users logged in.
type GuestSSHKeys struct {
	Users []GuestUserSSHKeys `json:"users"`
}

// GuestUserSSHKeys are one user's authorized keys. A user whose keys could
// not be read has a Reason and a Message instead.
type GuestUserSSHKeys struct {
	Username string   `json:"username"`
	Keys     []string `json:"keys"`
	Reason   string   `json:"reason,omitempty"`
	Message  string   `json:"message,omitempty"`
}

// GuestTime is the section "time": guest-get-time, next to the bridge's
// clock. DriftSeconds is the guest's time minus the host's.
type GuestTime struct {
	GuestTime    metav1.MicroTime `json:"guestTime"`
	HostTime     metav1.MicroTime `json:"hostTime"`
	DriftSeconds float64          `json:"driftSeconds"`
}
