package agent

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf16"
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

// The agent commands of the guestfiles subresource. Their replies are
// bounded by the builders below: a guest-file-read by its count, a
// guest-exec-status by what the bridge's scripts print.
const (
	CmdExec       = "guest-exec"
	CmdExecStatus = "guest-exec-status"
	CmdFileOpen   = "guest-file-open"
	CmdFileClose  = "guest-file-close"
	CmdFileRead   = "guest-file-read"
	CmdFileWrite  = "guest-file-write"
	CmdFileSeek   = "guest-file-seek"
)

// Command is one guest agent command.
//
// Only this package's functions make a Command, each from typed parameters
// it checks: the bridge never sends a command string that came from a
// client. A new command gets its own function here.
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

// The limits of the file commands, measured by the prototype on KubeVirt
// v1.9.1 (libvirt 11.10).
const (
	// MaxFileWrite bounds the raw bytes of one guest-file-write. libvirt
	// re-sends forever an agent command larger than the agent socket's send
	// buffer (about 208 KiB): a 160 KiB write (218 KB of JSON) works, 168 KiB
	// hangs the VM's agent until the timeout, KubeVirt's poller included
	// (https://gitlab.com/libvirt/libvirt/-/work_items/960). 128 KiB is
	// 175 KB of JSON. The limit stays until a fixed libvirt reaches KubeVirt.
	MaxFileWrite = 128 << 10
	// MaxFileRead bounds one guest-file-read: 1 MiB is the fastest size
	// measured, and its reply (1.4 MB of base64) stays far below libvirt's
	// 4 MiB RPC string. A reply over libvirt's 10 MiB agent limit breaks the
	// agent for every client until qemu-ga restarts in the guest.
	MaxFileRead = 1 << 20
	// MaxPath bounds a path in the guest.
	MaxPath = 4096
	// maxExecArgs bounds what one guest-exec carries (its arguments, the
	// script included), far below the send buffer of MaxFileWrite.
	maxExecArgs = 64 << 10
	// maxCommandLine is the longest command line Windows' CreateProcess
	// takes, in UTF-16 units.
	maxCommandLine = 32767
)

// FileMode is how guest-file-open opens a file.
type FileMode string

// The modes the bridge uses (qemu-ga takes fopen's).
const (
	// FileReadOnly reads a file that exists.
	FileReadOnly FileMode = "r"
	// FileUpdate reads and writes a file that exists, from its start.
	FileUpdate FileMode = "r+"
	// FileTruncate writes a file: it is created, or emptied if it exists.
	FileTruncate FileMode = "w"
)

// Whence is where guest-file-seek counts its offset from.
type Whence string

// The origins of a seek.
const (
	SeekSet Whence = "set"
	SeekEnd Whence = "end"
)

// FileOpen is guest-file-open of path. Its reply is the handle.
func FileOpen(path string, mode FileMode) (Command, error) {
	if err := validGuestString("path", path, MaxPath); err != nil {
		return Command{}, err
	}
	switch mode {
	case FileReadOnly, FileUpdate, FileTruncate:
	default:
		return Command{}, fmt.Errorf("unknown file mode %q", mode)
	}
	return Command{name: CmdFileOpen, args: struct {
		Path string `json:"path"`
		Mode string `json:"mode"`
	}{path, string(mode)}}, nil
}

type handleArgs struct {
	Handle int64 `json:"handle"`
}

// FileClose is guest-file-close: it flushes and closes the handle.
func FileClose(handle int64) Command {
	return Command{name: CmdFileClose, args: handleArgs{handle}}
}

// FileRead is guest-file-read of up to count bytes, 1 to MaxFileRead.
func FileRead(handle int64, count int) (Command, error) {
	if count < 1 || count > MaxFileRead {
		return Command{}, fmt.Errorf("a read of %d bytes: one guest-file-read reads 1 to %d", count, MaxFileRead)
	}
	return Command{name: CmdFileRead, args: struct {
		Handle int64 `json:"handle"`
		Count  int   `json:"count"`
	}{handle, count}}, nil
}

// FileWrite is guest-file-write of data, 1 to MaxFileWrite bytes (sent
// base64-encoded).
func FileWrite(handle int64, data []byte) (Command, error) {
	if len(data) < 1 || len(data) > MaxFileWrite {
		return Command{}, fmt.Errorf("a write of %d bytes: one guest-file-write writes 1 to %d", len(data), MaxFileWrite)
	}
	return Command{name: CmdFileWrite, args: struct {
		Handle int64  `json:"handle"`
		Buf    []byte `json:"buf-b64"`
		Count  int    `json:"count"`
	}{handle, data, len(data)}}, nil
}

// FileSeek is guest-file-seek. From SeekSet the offset is not negative.
func FileSeek(handle, offset int64, whence Whence) (Command, error) {
	switch {
	case whence != SeekSet && whence != SeekEnd:
		return Command{}, fmt.Errorf("unknown whence %q", whence)
	case whence == SeekSet && offset < 0:
		return Command{}, fmt.Errorf("a negative offset %d", offset)
	}
	return Command{name: CmdFileSeek, args: struct {
		Handle int64  `json:"handle"`
		Offset int64  `json:"offset"`
		Whence string `json:"whence"`
	}{handle, offset, string(whence)}}, nil
}

// script is the text of a program the bridge runs in the guest. The type is
// unexported: only an untyped string constant of the bridge's source
// converts to it, so no string a client sent can become a script. The
// client's values reach a script only as its arguments.
type script string

// The programs guest-exec runs.
const (
	shellPath      = "/bin/sh"
	powerShellPath = "powershell.exe"
)

type execArgs struct {
	Path          string   `json:"path"`
	Arg           []string `json:"arg"`
	CaptureOutput bool     `json:"capture-output"`
}

// ShellScript is guest-exec of /bin/sh -c s sh args...: the arguments are
// the script's $1, $2..., given to the program as they are and never parsed
// by a shell. Its output is captured; the script bounds it.
func ShellScript(s script, args ...string) (Command, error) {
	argv := append([]string{"-c", string(s), "sh"}, args...)
	total := 0
	for i, a := range argv {
		if err := validGuestString(fmt.Sprintf("argument %d", i), a, maxExecArgs); err != nil {
			return Command{}, err
		}
		total += len(a)
	}
	if total > maxExecArgs {
		return Command{}, fmt.Errorf("guest-exec arguments of %d bytes, over %d", total, maxExecArgs)
	}
	return Command{name: CmdExec, args: execArgs{Path: shellPath, Arg: argv, CaptureOutput: true}}, nil
}

// PowerShellScript is guest-exec of powershell.exe -NoProfile
// -NonInteractive -EncodedCommand with s, after a line that sets $A to
// params. params travel as JSON in a base64 literal, which PowerShell never
// parses as code. Its output is captured; the script bounds it.
func PowerShellScript(s script, params any) (Command, error) {
	p, err := json.Marshal(params)
	if err != nil {
		return Command{}, err
	}
	text := "$A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
		base64.StdEncoding.EncodeToString(p) + "')) | ConvertFrom-Json\n" + string(s)
	if err := validGuestString("script", text, maxExecArgs); err != nil {
		return Command{}, err
	}
	encoded := base64.StdEncoding.EncodeToString(utf16LE(text))
	argv := []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", encoded}
	line := len(powerShellPath)
	for _, a := range argv {
		line += 1 + len(a)
	}
	if line > maxCommandLine {
		return Command{}, fmt.Errorf("a PowerShell command line of %d characters, over %d", line, maxCommandLine)
	}
	return Command{name: CmdExec, args: execArgs{Path: powerShellPath, Arg: argv, CaptureOutput: true}}, nil
}

// DecodePowerShell returns the script text of a command line that
// PowerShellScript built: for tests and fakes.
func DecodePowerShell(encoded string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	if len(b)%2 != 0 {
		return "", fmt.Errorf("an odd number of UTF-16 bytes")
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u)), nil
}

func utf16LE(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(u))
	for i, v := range u {
		binary.LittleEndian.PutUint16(b[2*i:], v)
	}
	return b
}

// ExecStatus is guest-exec-status of a program guest-exec started.
func ExecStatus(pid int64) Command {
	return Command{name: CmdExecStatus, args: struct {
		PID int64 `json:"pid"`
	}{pid}}
}

// validGuestString checks a string the agent gets: UTF-8, as JSON carries
// it, without NUL, which no path or argument holds, and at most max bytes.
func validGuestString(what, s string, max int) error {
	switch {
	case s == "" && what == "path":
		return fmt.Errorf("an empty path")
	case len(s) > max:
		return fmt.Errorf("a %s of %d bytes, over %d", what, len(s), max)
	case !utf8.ValidString(s):
		return fmt.Errorf("a %s that is not UTF-8", what)
	case strings.IndexByte(s, 0) >= 0:
		return fmt.Errorf("a %s with a NUL byte", what)
	}
	return nil
}
