package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The agent commands the bridge sends. The guestinfo subresource's fixed list
// is every name below but CmdPing, which the health checks use.
//
// Every reply of these commands is a few KB, far below libvirt's 4 MiB RPC
// string and its 10 MiB agent reply limit (a reply over it breaks the agent
// for every client until qemu-ga restarts in the guest).
const (
	CmdInfo                 = "guest-info"
	CmdPing                 = "guest-ping"
	CmdGetOSInfo            = "guest-get-osinfo"
	CmdGetHostName          = "guest-get-host-name"
	CmdGetTimezone          = "guest-get-timezone"
	CmdGetUsers             = "guest-get-users"
	CmdGetVCPUs             = "guest-get-vcpus"
	CmdGetCPUStats          = "guest-get-cpustats"
	CmdGetLoad              = "guest-get-load"
	CmdGetMemoryBlocks      = "guest-get-memory-blocks"
	CmdGetDisks             = "guest-get-disks"
	CmdGetDiskStats         = "guest-get-diskstats"
	CmdGetFSInfo            = "guest-get-fsinfo"
	CmdGetTime              = "guest-get-time"
	CmdNetworkGetInterfaces = "guest-network-get-interfaces"
	CmdNetworkGetRoute      = "guest-network-get-route"
	CmdGetDevices           = "guest-get-devices"
	CmdSSHGetAuthorizedKeys = "guest-ssh-get-authorized-keys"
)

// Command is one guest agent command.
//
// Only this package's functions make a Command, each from typed parameters
// it checks: the bridge never sends a command string that came from a
// client. A new command (guestfiles' guest-file-* and guest-exec, say) gets
// its own function here.
type Command struct {
	name string
	args any
}

// Name is the command's name, such as "guest-info".
func (c Command) Name() string { return c.name }

// MarshalJSON returns the command as the agent reads it:
// {"execute": name, "arguments": {...}}.
func (c Command) MarshalJSON() ([]byte, error) {
	if c.name == "" {
		return nil, fmt.Errorf("an empty agent command")
	}
	return json.Marshal(struct {
		Execute   string `json:"execute"`
		Arguments any    `json:"arguments,omitempty"`
	}{c.name, c.args})
}

func noArgs(name string) Command { return Command{name: name} }

// Info is guest-info: the agent's version and its commands.
func Info() Command { return noArgs(CmdInfo) }

// Ping is guest-ping.
func Ping() Command { return noArgs(CmdPing) }

// GetOSInfo is guest-get-osinfo.
func GetOSInfo() Command { return noArgs(CmdGetOSInfo) }

// GetHostName is guest-get-host-name.
func GetHostName() Command { return noArgs(CmdGetHostName) }

// GetTimezone is guest-get-timezone.
func GetTimezone() Command { return noArgs(CmdGetTimezone) }

// GetUsers is guest-get-users: the users logged in.
func GetUsers() Command { return noArgs(CmdGetUsers) }

// GetVCPUs is guest-get-vcpus.
func GetVCPUs() Command { return noArgs(CmdGetVCPUs) }

// GetCPUStats is guest-get-cpustats (Linux).
func GetCPUStats() Command { return noArgs(CmdGetCPUStats) }

// GetLoad is guest-get-load (qemu-ga 10.0 and later).
func GetLoad() Command { return noArgs(CmdGetLoad) }

// GetMemoryBlocks is guest-get-memory-blocks (Linux).
func GetMemoryBlocks() Command { return noArgs(CmdGetMemoryBlocks) }

// GetDisks is guest-get-disks.
func GetDisks() Command { return noArgs(CmdGetDisks) }

// GetDiskStats is guest-get-diskstats (Linux).
func GetDiskStats() Command { return noArgs(CmdGetDiskStats) }

// GetFSInfo is guest-get-fsinfo.
func GetFSInfo() Command { return noArgs(CmdGetFSInfo) }

// GetTime is guest-get-time.
func GetTime() Command { return noArgs(CmdGetTime) }

// NetworkGetInterfaces is guest-network-get-interfaces.
func NetworkGetInterfaces() Command { return noArgs(CmdNetworkGetInterfaces) }

// NetworkGetRoute is guest-network-get-route (Linux, qemu-ga 9.1 and later).
func NetworkGetRoute() Command { return noArgs(CmdNetworkGetRoute) }

// GetDevices is guest-get-devices (Windows).
func GetDevices() Command { return noArgs(CmdGetDevices) }

// maxUsernameBytes bounds a user name: Linux allows 32 bytes, Windows 20
// characters (up to 80 bytes of UTF-8).
const maxUsernameBytes = 256

// SSHGetAuthorizedKeys is guest-ssh-get-authorized-keys for one user.
//
// The user names come from the guest itself (guest-get-users) or are root;
// a name with a control character, a slash or more than 256 bytes is
// refused all the same.
func SSHGetAuthorizedKeys(username string) (Command, error) {
	if err := validUsername(username); err != nil {
		return Command{}, err
	}
	return Command{name: CmdSSHGetAuthorizedKeys, args: struct {
		Username string `json:"username"`
	}{username}}, nil
}

func validUsername(name string) error {
	switch {
	case name == "":
		return fmt.Errorf("an empty user name")
	case len(name) > maxUsernameBytes:
		return fmt.Errorf("a user name of %d bytes, over %d", len(name), maxUsernameBytes)
	case !utf8.ValidString(name):
		return fmt.Errorf("a user name that is not UTF-8")
	case strings.ContainsRune(name, '/'):
		return fmt.Errorf("a user name with a slash: %q", name)
	case strings.IndexFunc(name, unicode.IsControl) >= 0:
		return fmt.Errorf("a user name with a control character: %q", name)
	}
	return nil
}
