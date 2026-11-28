package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCommandJSON(t *testing.T) {
	keys, err := SSHGetAuthorizedKeys("fedora")
	if err != nil {
		t.Fatal(err)
	}
	quoted, err := SSHGetAuthorizedKeys(`a"b`)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		cmd  Command
		want string
	}{
		{Info(), `{"execute":"guest-info"}`},
		{Ping(), `{"execute":"guest-ping"}`},
		{GetOSInfo(), `{"execute":"guest-get-osinfo"}`},
		{GetHostName(), `{"execute":"guest-get-host-name"}`},
		{GetTimezone(), `{"execute":"guest-get-timezone"}`},
		{GetUsers(), `{"execute":"guest-get-users"}`},
		{GetVCPUs(), `{"execute":"guest-get-vcpus"}`},
		{GetCPUStats(), `{"execute":"guest-get-cpustats"}`},
		{GetLoad(), `{"execute":"guest-get-load"}`},
		{GetMemoryBlocks(), `{"execute":"guest-get-memory-blocks"}`},
		{GetDisks(), `{"execute":"guest-get-disks"}`},
		{GetDiskStats(), `{"execute":"guest-get-diskstats"}`},
		{GetFSInfo(), `{"execute":"guest-get-fsinfo"}`},
		{GetTime(), `{"execute":"guest-get-time"}`},
		{NetworkGetInterfaces(), `{"execute":"guest-network-get-interfaces"}`},
		{NetworkGetRoute(), `{"execute":"guest-network-get-route"}`},
		{GetDevices(), `{"execute":"guest-get-devices"}`},
		{keys, `{"execute":"guest-ssh-get-authorized-keys","arguments":{"username":"fedora"}}`},
		// A quote stays inside the string.
		{quoted, `{"execute":"guest-ssh-get-authorized-keys","arguments":{"username":"a\"b"}}`},
	} {
		got, err := json.Marshal(tc.cmd)
		if err != nil || string(got) != tc.want {
			t.Errorf("%s: %s, %v; want %s", tc.cmd.Name(), got, err, tc.want)
		}
	}
	if _, err := json.Marshal(Command{}); err == nil {
		t.Error("the zero Command marshals")
	}
}

func TestSSHUsername(t *testing.T) {
	for _, name := range []string{"", "a/b", "../../etc", "a\nb", "a\x00b", "\xff", strings.Repeat("a", 257)} {
		if _, err := SSHGetAuthorizedKeys(name); err == nil {
			t.Errorf("%q accepted", name)
		}
	}
	for _, name := range []string{"root", "k4all", "Administrator", "DOMAIN\\user", "jérôme", "first.last"} {
		if _, err := SSHGetAuthorizedKeys(name); err != nil {
			t.Errorf("%q refused: %v", name, err)
		}
	}
}
