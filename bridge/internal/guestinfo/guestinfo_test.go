package guestinfo

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
	"k8s.io/apimachinery/pkg/types"
	clocktesting "k8s.io/utils/clock/testing"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/guest"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// t0 is the host's time in the tests; the Linux fixtures' guests are
// 0.25 s ahead, the Windows one 1 s behind.
var t0 = time.Date(2026, 11, 28, 4, 0, 0, 0, time.UTC)

// readOnly is the guestinfo subresource's fixed list, and guest-ping.
var readOnly = []string{
	agent.CmdInfo, agent.CmdPing, agent.CmdGetOSInfo, agent.CmdGetHostName, agent.CmdGetTimezone,
	agent.CmdGetUsers, agent.CmdGetVCPUs, agent.CmdGetCPUStats, agent.CmdGetLoad, agent.CmdGetMemoryBlocks,
	agent.CmdGetDisks, agent.CmdGetDiskStats, agent.CmdGetFSInfo, agent.CmdGetTime,
	agent.CmdNetworkGetInterfaces, agent.CmdNetworkGetRoute, agent.CmdGetDevices, agent.CmdSSHGetAuthorizedKeys,
}

func newVM(c agent.Caller, clk *clocktesting.FakeClock) *agent.VM {
	return agent.NewVM("vms_vm", c, agent.VMConfig{Clock: clk, CallTimeout: 2 * time.Second})
}

func read(t *testing.T, vm *agent.VM, clk *clocktesting.FakeClock, sections ...string) *v1alpha1.GuestInfo {
	t.Helper()
	if sections == nil {
		sections = v1alpha1.Sections
	}
	info, err := Read(context.Background(), vm, sections, clk)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	return info
}

// TestFixtures reads every section from each guest's fixture and compares
// the answer with testdata/<guest>.golden.json (go test -update rewrites
// them). The goldens are also the API's examples.
func TestFixtures(t *testing.T) {
	cases := []struct {
		fixture string
		// notCalled are commands the bridge must not call on this guest.
		notCalled []string
		// errors are the expected errors, as section/command/reason.
		errors []string
	}{
		{
			fixture: "fedora",
			// guest-get-devices is Windows-only: qemu-ga 11 does not list
			// it on Linux. SELinux confines the agent away from /root.
			notCalled: []string{agent.CmdGetDevices},
			errors:    []string{"devices/guest-get-devices/NotSupported"},
		},
		{
			fixture:   "rocky-blocked",
			notCalled: []string{agent.CmdGetUsers, agent.CmdSSHGetAuthorizedKeys, agent.CmdNetworkGetRoute, agent.CmdGetDevices},
			errors: []string{
				"network/guest-network-get-route/Blocked",
				"users/guest-get-users/Blocked",
				"devices/guest-get-devices/NotSupported",
				"sshkeys/guest-ssh-get-authorized-keys/Blocked",
			},
		},
		{
			fixture:   "ubuntu-8.2",
			notCalled: []string{agent.CmdGetLoad, agent.CmdNetworkGetRoute, agent.CmdGetDevices},
			errors: []string{
				"cpu/guest-get-load/NotSupported",
				"network/guest-network-get-route/NotSupported",
				"devices/guest-get-devices/NotSupported",
			},
		},
		{
			fixture:   "windows",
			notCalled: []string{agent.CmdGetCPUStats, agent.CmdGetDiskStats, agent.CmdGetMemoryBlocks, agent.CmdGetLoad, agent.CmdNetworkGetRoute},
			errors: []string{
				"cpu/guest-get-cpustats/NotSupported",
				"cpu/guest-get-load/NotSupported",
				"memory/guest-get-memory-blocks/NotSupported",
				"disks/guest-get-diskstats/NotSupported",
				"network/guest-network-get-route/NotSupported",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			caller := loadFixture(t, tc.fixture)
			clk := clocktesting.NewFakeClock(t0)
			info := read(t, newVM(caller, clk), clk)

			if !info.Agent.Connected || !info.Agent.Healthy {
				t.Errorf("agent = %+v, want connected and healthy", info.Agent)
			}
			var errs []string
			for _, e := range info.Errors {
				errs = append(errs, e.Section+"/"+e.Command+"/"+e.Reason)
				if e.Message == "" {
					t.Errorf("error %+v has no message", e)
				}
			}
			if !slices.Equal(errs, tc.errors) {
				t.Errorf("errors =\n  %s\nwant\n  %s", strings.Join(errs, "\n  "), strings.Join(tc.errors, "\n  "))
			}
			called := caller.names()
			if called[0] != agent.CmdInfo {
				t.Errorf("the first command is %s, want guest-info", called[0])
			}
			for _, c := range called {
				if !slices.Contains(readOnly, c) {
					t.Errorf("called %s, which is not read-only", c)
				}
			}
			for _, c := range tc.notCalled {
				if slices.Contains(called, c) {
					t.Errorf("called %s, which guest-info rules out", c)
				}
			}
			if n := strings.Count(strings.Join(called, " "), agent.CmdGetUsers); n > 1 {
				t.Errorf("guest-get-users called %d times, want once", n)
			}

			got, err := json.MarshalIndent(info, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			got = append(got, '\n')
			golden := filepath.Join("testdata", tc.fixture+".golden.json")
			if *update {
				if err := os.WriteFile(golden, got, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v (go test -update writes it)", err)
			}
			if !bytes.Equal(got, want) {
				t.Errorf("the answer differs from %s (go test -update rewrites it):\n%s", golden, got)
			}
		})
	}
}

// TestFixtureDetails checks what the goldens show, the fields a UI needs.
func TestFixtureDetails(t *testing.T) {
	clk := clocktesting.NewFakeClock(t0)

	fedora := read(t, newVM(loadFixture(t, "fedora"), clk), clk)
	if fedora.Agent.Version != "11.1.2" || len(fedora.Agent.Commands) != 43 {
		t.Errorf("agent %s with %d commands", fedora.Agent.Version, len(fedora.Agent.Commands))
	}
	if os := fedora.System.OS; os == nil || os.PrettyName != "Fedora Linux 45 (Cloud Edition)" || os.VersionID != "45" || os.KernelRelease == "" {
		t.Errorf("os = %+v", fedora.System.OS)
	}
	if fedora.System.HostName != "fedora" || fedora.System.Timezone == nil || fedora.System.Timezone.Zone != "UTC" {
		t.Errorf("system = %+v", fedora.System)
	}
	if d := fedora.Disks.Disks[2]; d.Address == nil || d.Address.Serial != "rootdisk" || d.Address.BusType != "virtio" || d.Address.PCIController.Bus != 7 {
		t.Errorf("disk vda = %+v", d)
	}
	if fs := fedora.Disks.Filesystems[0]; fs.Mountpoint != "/" || *fs.UsedBytes != 4473618432 || fs.Disk[0].Serial != "rootdisk" {
		t.Errorf("filesystem / = %+v", fs)
	}
	eth0 := fedora.Network.Interfaces[1]
	if eth0.HardwareAddress != "02:5e:7a:00:00:01" || eth0.IPAddresses[0].IPAddressType != "ipv4" || eth0.Statistics.RxBytes != 18446744073709551000 {
		t.Errorf("eth0 = %+v (a 64-bit counter must keep its precision)", eth0)
	}
	if len(fedora.Network.Routes) != 3 || fedora.Network.Routes[0].Gateway != "10.0.2.1" || fedora.Network.Routes[2].Version != 6 {
		t.Errorf("routes = %+v", fedora.Network.Routes)
	}
	if l := fedora.CPU.Load; l == nil || l.Load1 != 0.08 {
		t.Errorf("load = %+v", l)
	}
	if fedora.Time.DriftSeconds != 0.25 {
		t.Errorf("drift = %v, want 0.25", fedora.Time.DriftSeconds)
	}
	keys := fedora.SSHKeys.Users
	if len(keys) != 2 || keys[0].Username != "root" || keys[0].Reason != v1alpha1.ReasonAgentError ||
		!strings.Contains(keys[0].Message, "Permission denied") || keys[1].Username != "fedora" || len(keys[1].Keys) != 1 {
		t.Errorf("ssh keys = %+v", keys)
	}

	ubuntu := read(t, newVM(loadFixture(t, "ubuntu-8.2"), clk), clk)
	for _, e := range ubuntu.Errors {
		if e.Command == agent.CmdGetLoad && !strings.Contains(e.Message, "needs qemu-ga 10.0") {
			t.Errorf("guest-get-load: %q, want the version it needs", e.Message)
		}
	}
	// Two sessions of ubuntu: one entry. No authorized_keys for root: no
	// keys, no error.
	if k := ubuntu.SSHKeys.Users; len(k) != 2 || k[0].Username != "root" || k[0].Reason != "" || len(k[0].Keys) != 0 || k[1].Username != "ubuntu" {
		t.Errorf("ssh keys = %+v", k)
	}

	windows := read(t, newVM(loadFixture(t, "windows"), clk), clk)
	if windows.System.OS.ID != "mswindows" || windows.Users.Items[0].Domain != "WIN-GUEST" {
		t.Errorf("windows = %+v, users %+v", windows.System.OS, windows.Users)
	}
	if d := windows.Devices.Items; len(d) != 4 || d[0].ID == nil || d[0].ID.VendorID != 6900 || *d[0].DriverDate != 1704067200000000000 || d[3].ID != nil {
		t.Errorf("devices = %+v", d)
	}
	if k := windows.SSHKeys.Users; len(k) != 1 || k[0].Username != "Administrator" {
		t.Errorf("ssh keys = %+v, want Administrator only (no root on Windows)", k)
	}
	if windows.Time.DriftSeconds != -1 {
		t.Errorf("drift = %v, want -1", windows.Time.DriftSeconds)
	}
}

func TestSectionsSubset(t *testing.T) {
	caller := loadFixture(t, "fedora")
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk, v1alpha1.SectionNetwork, v1alpha1.SectionTime)
	if got := caller.names(); !slices.Equal(got, []string{agent.CmdInfo, agent.CmdNetworkGetInterfaces, agent.CmdNetworkGetRoute, agent.CmdGetTime}) {
		t.Errorf("called %v", got)
	}
	if info.Network == nil || info.Time == nil || info.System != nil || info.CPU != nil || info.Users != nil {
		t.Errorf("sections: %+v", info)
	}

	// The devices section reads the OS to tell "not for this OS", but shows
	// no system block.
	caller.reset()
	info = read(t, newVM(caller, clk), clk, v1alpha1.SectionDevices)
	if got := caller.names(); !slices.Equal(got, []string{agent.CmdInfo, agent.CmdGetOSInfo}) {
		t.Errorf("called %v", got)
	}
	if info.System != nil || info.Devices != nil || len(info.Errors) != 1 || info.Errors[0].Reason != v1alpha1.ReasonNotSupported {
		t.Errorf("devices on Linux: %+v", info)
	}
}

func TestParseSections(t *testing.T) {
	for _, tc := range []struct {
		in   []string
		want []string
		bad  bool
	}{
		{in: nil, want: v1alpha1.Sections},
		{in: []string{""}, want: v1alpha1.Sections},
		{in: []string{"time,system"}, want: []string{"system", "time"}},
		{in: []string{"cpu", "cpu, users"}, want: []string{"cpu", "users"}},
		{in: []string{"system,exec"}, bad: true},
		{in: []string{`{"execute":"guest-exec"}`}, bad: true},
	} {
		got, err := ParseSections(tc.in)
		if (err != nil) != tc.bad || (!tc.bad && !slices.Equal(got, tc.want)) {
			t.Errorf("ParseSections(%q) = %v, %v", tc.in, got, err)
		}
	}
}

func TestNotConnected(t *testing.T) {
	caller := loadFixture(t, "fedora")
	caller.override = func(string) (bool, string, error) {
		return true, "", libvirt.Error{Code: uint32(libvirt.ErrAgentUnresponsive), Message: "Guest agent is not responding: QEMU guest agent is not connected"}
	}
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk)
	if info.Agent.Connected || info.Agent.Healthy || !strings.Contains(info.Agent.Message, "not connected") {
		t.Errorf("agent = %+v", info.Agent)
	}
	if len(info.Errors) != 0 || info.System != nil {
		t.Errorf("not connected: %+v", info)
	}
	if got := caller.names(); !slices.Equal(got, []string{agent.CmdInfo}) {
		t.Errorf("called %v, want guest-info only", got)
	}
}

// TestNotResponding is libvirt's agent error state (a reply over 10 MiB
// causes it): the VM is marked not responding, the bridge stops calling it
// but for one ping per 30 s, and a qemu-ga restart in the guest brings it
// back.
func TestNotResponding(t *testing.T) {
	caller := loadFixture(t, "fedora")
	broken := true
	caller.override = func(string) (bool, string, error) {
		if broken {
			return true, "", libvirt.Error{Code: uint32(libvirt.ErrAgentUnresponsive),
				Message: "Guest agent is not responding: QEMU guest agent is not available due to an error"}
		}
		return false, "", nil
	}
	clk := clocktesting.NewFakeClock(t0)
	vm := newVM(caller, clk)

	check := func(step string, wantCalls []string) *v1alpha1.GuestInfo {
		t.Helper()
		caller.reset()
		info := read(t, vm, clk)
		if got := caller.names(); !slices.Equal(got, wantCalls) {
			t.Errorf("%s: called %v, want %v", step, got, wantCalls)
		}
		return info
	}

	info := check("broken", []string{agent.CmdInfo})
	if !info.Agent.Connected || info.Agent.Healthy || !strings.Contains(info.Agent.Message, "restart qemu-guest-agent") {
		t.Errorf("agent = %+v", info.Agent)
	}
	if len(info.Errors) != len(v1alpha1.Sections) {
		t.Fatalf("errors = %+v, want one per section", info.Errors)
	}
	for _, e := range info.Errors {
		if e.Reason != v1alpha1.ReasonNotResponding || !strings.Contains(e.Message, "systemctl restart qemu-guest-agent") {
			t.Errorf("error %+v", e)
		}
	}

	clk.Step(10 * time.Second)
	check("within 30 s: no agent call at all", nil)

	clk.Step(21 * time.Second)
	info = check("after 30 s: one ping, still broken", []string{agent.CmdPing})
	if info.Agent.Healthy {
		t.Error("healthy after a failed ping")
	}

	clk.Step(5 * time.Second)
	check("the next window starts at the failed ping", nil)

	broken = false // qemu-ga restarted in the guest
	clk.Step(26 * time.Second)
	info = check("the ping answers: a full read", append([]string{agent.CmdPing, agent.CmdInfo}, fullRead(t)...))
	if !info.Agent.Healthy || len(info.Errors) != 1 {
		t.Errorf("after the restart: agent %+v, errors %+v", info.Agent, info.Errors)
	}
}

// fullRead are the commands of a healthy full read of the fedora fixture,
// after guest-info.
func fullRead(t *testing.T) []string {
	t.Helper()
	other := loadFixture(t, "fedora")
	clk := clocktesting.NewFakeClock(t0)
	read(t, newVM(other, clk), clk)
	return other.names()[1:]
}

// TestHungCommand: a command times out and the agent then answers no ping
// either: the rest of the call is NotResponding, without agent calls.
func TestHungCommand(t *testing.T) {
	caller := loadFixture(t, "fedora")
	hung := false
	caller.override = func(name string) (bool, string, error) {
		if name == agent.CmdGetFSInfo {
			hung = true
		}
		if hung {
			return true, "", libvirt.Error{Code: uint32(libvirt.ErrAgentCommandTimeout), Message: "Guest agent didn't respond to command within timeout"}
		}
		return false, "", nil
	}
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk)
	called := caller.names()
	at := slices.Index(called, agent.CmdGetFSInfo)
	if at < 0 || !slices.Equal(called[at:], []string{agent.CmdGetFSInfo, agent.CmdPing}) {
		t.Errorf("called %v: want guest-get-fsinfo, one ping, then nothing", called)
	}
	var reasons []string
	for _, e := range info.Errors {
		reasons = append(reasons, e.Command+"/"+e.Reason)
	}
	if reasons[0] != "guest-get-fsinfo/Timeout" || !slices.Contains(reasons, "guest-get-time/NotResponding") {
		t.Errorf("errors %v", reasons)
	}
	if info.Agent.Healthy {
		t.Error("healthy after a hung command and a failed ping")
	}
	if info.Disks == nil || len(info.Disks.Disks) == 0 {
		t.Error("the disks read before the hang are lost")
	}
}

// TestSlowCommand: a command times out but the agent answers a ping: only
// that command is a Timeout.
func TestSlowCommand(t *testing.T) {
	caller := loadFixture(t, "fedora")
	caller.override = func(name string) (bool, string, error) {
		if name == agent.CmdGetFSInfo {
			return true, "", libvirt.Error{Code: uint32(libvirt.ErrAgentCommandTimeout), Message: "Guest agent didn't respond to command within timeout"}
		}
		return false, "", nil
	}
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk)
	if !info.Agent.Healthy || len(info.Errors) != 2 || info.Errors[0].Command != agent.CmdGetFSInfo || info.Errors[0].Reason != v1alpha1.ReasonTimeout {
		t.Errorf("agent %+v, errors %+v", info.Agent, info.Errors)
	}
}

// TestDisabledRace: a command guest-info listed as enabled answers "has
// been disabled" (the configuration changed in between): it is Blocked.
func TestDisabledRace(t *testing.T) {
	caller := loadFixture(t, "fedora")
	caller.override = func(name string) (bool, string, error) {
		if name == agent.CmdGetUsers {
			return true, "", libvirt.Error{Code: uint32(libvirt.ErrAgentCommandFailed), Message: "guest agent command failed: unable to execute QEMU agent command 'guest-get-users': Command guest-get-users has been disabled: the command is not allowed"}
		}
		return false, "", nil
	}
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk, v1alpha1.SectionUsers)
	if len(info.Errors) != 1 || info.Errors[0].Reason != v1alpha1.ReasonBlocked || !strings.Contains(info.Errors[0].Message, "FILTER_RPC_ARGS") {
		t.Errorf("errors %+v", info.Errors)
	}
}

// TestNoGuestInfo: an allow-list without guest-info. The commands run
// ungated, and their own errors tell what is blocked.
func TestNoGuestInfo(t *testing.T) {
	caller := loadFixture(t, "fedora")
	caller.override = func(name string) (bool, string, error) {
		if name == agent.CmdInfo || name == agent.CmdGetHostName {
			return true, "", libvirt.Error{Code: uint32(libvirt.ErrAgentCommandFailed),
				Message: "guest agent command failed: unable to execute QEMU agent command '" + name + "': Command " + name + " has been disabled: the command is not allowed"}
		}
		return false, "", nil
	}
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk, v1alpha1.SectionSystem)
	if info.Agent.Commands != nil || !strings.Contains(info.Agent.Message, "guest-info failed") || !info.Agent.Healthy {
		t.Errorf("agent = %+v", info.Agent)
	}
	if info.System == nil || info.System.OS == nil || info.System.Timezone == nil ||
		len(info.Errors) != 1 || info.Errors[0].Command != agent.CmdGetHostName || info.Errors[0].Reason != v1alpha1.ReasonBlocked {
		t.Errorf("system %+v, errors %+v", info.System, info.Errors)
	}
}

// TestUnexpectedReply: a reply of the wrong shape is an AgentError for its
// command only.
func TestUnexpectedReply(t *testing.T) {
	caller := loadFixture(t, "fedora")
	caller.override = func(name string) (bool, string, error) {
		if name == agent.CmdGetVCPUs {
			return true, `{"return":{"not":"a list"}}`, nil
		}
		return false, "", nil
	}
	clk := clocktesting.NewFakeClock(t0)
	info := read(t, newVM(caller, clk), clk, v1alpha1.SectionCPU)
	if len(info.Errors) != 1 || info.Errors[0].Reason != v1alpha1.ReasonAgentError || info.CPU == nil || len(info.CPU.Stats) != 2 {
		t.Errorf("cpu %+v, errors %+v", info.CPU, info.Errors)
	}
}

// TestNoClientString: whatever the query holds, the agent gets only the
// fixed list's commands, built by the bridge.
func TestNoClientString(t *testing.T) {
	caller := loadFixture(t, "fedora")
	clk := clocktesting.NewFakeClock(t0)
	h := &Handler{VMs: fixedVM{newVM(caller, clk)}, Clock: clk}
	target := guest.Target{Namespace: "vms", Name: "vm", Node: "node-a", Pods: []types.UID{"pod-1"}}

	for _, q := range []string{
		`sections=system&execute=guest-exec&arguments={"path":"/bin/sh"}`,
		`sections=sshkeys&username=../../etc&cmd={"execute":"guest-file-open"}`,
		`sections=users,{"execute":"guest-exec"}`,
	} {
		r := httptest.NewRequest(http.MethodGet, "/x?"+strings.ReplaceAll(q, `"`, "%22"), nil)
		w := httptest.NewRecorder()
		h.ServeGuest(w, r, guest.Call{Target: target, Subresource: "guestinfo", Verb: "get"})
		if w.Code != http.StatusOK && w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", q, w.Code, w.Body)
		}
	}
	for _, raw := range caller.raw() {
		var c map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			t.Fatal(err)
		}
		var name string
		_ = json.Unmarshal(c["execute"], &name)
		if !slices.Contains(readOnly, name) {
			t.Errorf("sent %s", raw)
		}
		if args, ok := c["arguments"]; ok && name != agent.CmdSSHGetAuthorizedKeys {
			t.Errorf("%s with arguments %s", name, args)
		}
		for _, bad := range []string{"guest-exec", "guest-file", "/bin/sh", "../", "/etc"} {
			if strings.Contains(raw, bad) {
				t.Errorf("a client string reached the agent: %s", raw)
			}
		}
	}
	if len(caller.raw()) == 0 {
		t.Error("no command was sent")
	}
}

func TestHandlerErrors(t *testing.T) {
	clk := clocktesting.NewFakeClock(t0)
	target := guest.Target{Namespace: "vms", Name: "vm", Node: "node-a", Pods: []types.UID{"pod-1"}}
	call := guest.Call{Target: target, Subresource: "guestinfo", Verb: "get"}

	// A bad section: 400, and no agent call.
	caller := loadFixture(t, "fedora")
	h := &Handler{VMs: fixedVM{newVM(caller, clk)}, Clock: clk}
	w := httptest.NewRecorder()
	h.ServeGuest(w, httptest.NewRequest(http.MethodGet, "/x?sections=bogus", nil), call)
	if w.Code != http.StatusBadRequest || len(caller.raw()) != 0 {
		t.Errorf("bad section: %d %s, %d calls", w.Code, w.Body, len(caller.raw()))
	}

	// The connection to libvirt breaks: 503.
	caller.override = func(string) (bool, string, error) { return true, "", libvirt.ErrInterrupted }
	w = httptest.NewRecorder()
	h.ServeGuest(w, httptest.NewRequest(http.MethodGet, "/x", nil), call)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("connection lost: %d %s", w.Code, w.Body)
	}

	// The pool cannot reach the launcher: its API error passes.
	h = &Handler{VMs: failingVMs{agent.StatusError(agent.ErrNoDomain)}, Clock: clk}
	w = httptest.NewRecorder()
	h.ServeGuest(w, httptest.NewRequest(http.MethodGet, "/x", nil), call)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("no domain: %d %s", w.Code, w.Body)
	}

	// The answer is a GuestInfo.
	caller.override = nil
	h = &Handler{VMs: fixedVM{newVM(caller, clk)}, Clock: clk}
	w = httptest.NewRecorder()
	h.ServeGuest(w, httptest.NewRequest(http.MethodGet, "/x?sections=system", nil), call)
	var info v1alpha1.GuestInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil || w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if info.Kind != "GuestInfo" || info.APIVersion != "subresources.hangar.magesgate.com/v1alpha1" || !info.ReadAt.Time.Equal(t0) {
		t.Errorf("type meta and readAt: %+v %v", info.TypeMeta, info.ReadAt)
	}
}

type fixedVM struct{ vm *agent.VM }

func (f fixedVM) VM(context.Context, guest.Target) (*agent.VM, error) { return f.vm, nil }

type failingVMs struct{ err error }

func (f failingVMs) VM(context.Context, guest.Target) (*agent.VM, error) { return nil, f.err }
