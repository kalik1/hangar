// Package guestinfo serves the guestinfo subresource: what a VM's guest agent
// reports, from a fixed list of read-only agent commands.
//
//	GET .../virtualmachineinstances/{name}/guestinfo?sections=system,cpu,...&sshUsers=k4all
//
// The call reads guest-info first. A command it lists as disabled is
// reported Blocked and never called; one it does not list is NotSupported.
// The other commands of the requested sections run one at a time; what
// fails is in the answer's errors, and the sections that answered are
// there.
package guestinfo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/clock"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/guest"
)

// DefaultBudget bounds one guestinfo call, well under the API server's 60 s
// request timeout. Each command takes milliseconds; the budget is for an
// agent that hangs.
const DefaultBudget = 30 * time.Second

// MaxSSHUsers bounds the users whose authorized keys one call reads.
const MaxSSHUsers = 16

// MaxRequestedSSHUsers bounds the users a call names in "sshUsers".
const MaxRequestedSSHUsers = 4

// sshUserName is a user name a call may name in "sshUsers": a portable
// Linux user name, as useradd takes it by default.
var sshUserName = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// Request is what one guestinfo call asks for.
type Request struct {
	// Sections are the sections to read, in the answer's order.
	Sections []string
	// SSHUsers are users whose authorized keys the sshkeys section reads
	// too, logged in or not: for example the VM's cloud-init user.
	SSHUsers []string
}

// VMSource gives the agent of a VMI on this node: agent.Pool.
type VMSource interface {
	VM(ctx context.Context, t guest.Target) (*agent.VM, error)
}

// Handler serves guestinfo.
type Handler struct {
	VMs VMSource
	// Clock is the host's clock, for readAt and the guest's drift. Nil is
	// the real clock.
	Clock clock.PassiveClock
	// Budget bounds a call; zero is DefaultBudget.
	Budget time.Duration
}

var _ guest.Handler = (*Handler)(nil)

// ServeGuest implements guest.Handler.
func (h *Handler) ServeGuest(w http.ResponseWriter, r *http.Request, call guest.Call) {
	q := r.URL.Query()
	sections, err := ParseSections(q["sections"])
	if err != nil {
		guest.WriteError(w, apierrors.NewBadRequest(err.Error()))
		return
	}
	sshUsers, err := ParseSSHUsers(q["sshUsers"])
	if err != nil {
		guest.WriteError(w, apierrors.NewBadRequest(err.Error()))
		return
	}
	budget := h.Budget
	if budget <= 0 {
		budget = DefaultBudget
	}
	ctx, cancel := context.WithTimeout(r.Context(), budget)
	defer cancel()

	vm, err := h.VMs.VM(ctx, call.Target)
	if err != nil {
		guest.WriteError(w, agent.StatusError(err))
		return
	}
	info, err := Read(ctx, vm, Request{Sections: sections, SSHUsers: sshUsers}, h.Clock)
	if err != nil {
		if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
			return // the caller went away
		}
		guest.WriteError(w, agent.StatusError(err))
		return
	}
	guest.WriteObject(w, http.StatusOK, info)
}

// ParseSections reads the "sections" parameter: names separated by commas,
// in one or more values. None is every section.
func ParseSections(values []string) ([]string, error) {
	want := map[string]bool{}
	for _, v := range values {
		for _, s := range strings.Split(v, ",") {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			if !slices.Contains(v1alpha1.Sections, s) {
				return nil, fmt.Errorf("unknown section %q: the sections are %s", s, strings.Join(v1alpha1.Sections, ", "))
			}
			want[s] = true
		}
	}
	if len(want) == 0 {
		return slices.Clone(v1alpha1.Sections), nil
	}
	var out []string
	for _, s := range v1alpha1.Sections {
		if want[s] {
			out = append(out, s)
		}
	}
	return out, nil
}

// ParseSSHUsers reads the "sshUsers" parameter: user names separated by
// commas (spaces around them are dropped), in one or more values, at most
// MaxRequestedSSHUsers, each a portable Linux user name. Repeats count once.
func ParseSSHUsers(values []string) ([]string, error) {
	var out []string
	for _, v := range values {
		for _, u := range strings.Split(v, ",") {
			u = strings.Trim(u, " ")
			switch {
			case u == "":
				continue
			case !sshUserName.MatchString(u):
				return nil, fmt.Errorf("sshUsers: %q is not a user name (%s)", u, sshUserName)
			case slices.Contains(out, u):
				continue
			}
			out = append(out, u)
		}
	}
	if len(out) > MaxRequestedSSHUsers {
		return nil, fmt.Errorf("sshUsers names %d users; the limit is %d", len(out), MaxRequestedSSHUsers)
	}
	return out, nil
}

// Read reads the request's sections from the VM's agent.
//
// Its error ends the call before an answer: ErrConnectionLost, ErrNoDomain
// or a canceled context. Everything the agent says, its failures included,
// is in the GuestInfo.
func Read(ctx context.Context, vm *agent.VM, req Request, c clock.PassiveClock) (*v1alpha1.GuestInfo, error) {
	if c == nil {
		c = clock.RealClock{}
	}
	sections := req.Sections
	rd := &reader{ctx: ctx, vm: vm, clock: c, sshUsers: req.SSHUsers, info: &v1alpha1.GuestInfo{
		TypeMeta: metav1.TypeMeta{Kind: "GuestInfo", APIVersion: v1alpha1.SchemeGroupVersion.String()},
		ReadAt:   metav1.NewTime(c.Now()),
	}}
	rd.info.Agent.Connected = true
	rd.read(sections)
	if rd.fatal != nil {
		return nil, rd.fatal
	}
	h := vm.Health()
	rd.info.Agent.Healthy = rd.info.Agent.Connected && h.Healthy
	if rd.info.Agent.Connected && !h.Healthy && rd.info.Agent.Message == "" {
		rd.info.Agent.Message = h.Message
	}
	return rd.info, nil
}

type reader struct {
	ctx   context.Context
	vm    *agent.VM
	clock clock.PassiveClock
	info  *v1alpha1.GuestInfo
	// sshUsers are the users the call named for the sshkeys section.
	sshUsers []string

	// commands are guest-info's commands and whether each is enabled; nil
	// when guest-info did not answer.
	commands map[string]bool
	version  string
	windows  bool
	// stop is set when the agent went away mid-call: nothing more is
	// asked. fatal ends the call with an error.
	stop  bool
	fatal error

	users     []v1alpha1.GuestUser
	usersRead bool
	usersErr  *agent.Error
}

func (rd *reader) read(sections []string) {
	rd.readInfo(sections)
	if rd.stop {
		return
	}
	needOS := false
	for _, s := range sections {
		if s != v1alpha1.SectionNetwork && s != v1alpha1.SectionUsers && s != v1alpha1.SectionTime {
			needOS = true
		}
	}
	var osInfo v1alpha1.GuestOSInfo
	osSection := ""
	if slices.Contains(sections, v1alpha1.SectionSystem) {
		osSection = v1alpha1.SectionSystem
	}
	if needOS {
		// The OS tells which commands are for it; the system section shows
		// it.
		ok, e := rd.try(agent.GetOSInfo(), &osInfo)
		switch {
		case ok:
			rd.windows = osInfo.ID == "mswindows"
			if osSection != "" {
				rd.system().OS = &osInfo
			}
		case e != nil && osSection != "":
			rd.fail(osSection, e)
		}
	}
	for _, s := range sections {
		if rd.stop {
			return
		}
		switch s {
		case v1alpha1.SectionSystem:
			rd.readSystem()
		case v1alpha1.SectionCPU:
			rd.readCPU()
		case v1alpha1.SectionMemory:
			rd.readMemory()
		case v1alpha1.SectionDisks:
			rd.readDisks()
		case v1alpha1.SectionNetwork:
			rd.readNetwork()
		case v1alpha1.SectionUsers:
			rd.readUsers()
		case v1alpha1.SectionDevices:
			rd.readDevices()
		case v1alpha1.SectionSSHKeys:
			rd.readSSHKeys()
		case v1alpha1.SectionTime:
			rd.readTime()
		}
	}
}

// readInfo reads guest-info into the agent block. Without it, the commands
// run ungated: their own errors tell what is blocked.
func (rd *reader) readInfo(sections []string) {
	var gi struct {
		Version           string                       `json:"version"`
		SupportedCommands []v1alpha1.GuestAgentCommand `json:"supportedCommands"`
	}
	raw, err := rd.vm.Run(rd.ctx, agent.Info())
	if err == nil {
		if err := decode(raw, &gi); err != nil {
			rd.info.Agent.Message = fmt.Sprintf("guest-info answered something unexpected (%v); the commands run without knowing which are enabled", err)
			return
		}
		rd.version = gi.Version
		rd.info.Agent.Version = gi.Version
		rd.commands = make(map[string]bool, len(gi.SupportedCommands))
		for _, c := range gi.SupportedCommands {
			rd.commands[c.Name] = c.Enabled
		}
		rd.info.Agent.Commands = gi.SupportedCommands
		slices.SortFunc(rd.info.Agent.Commands, func(a, b v1alpha1.GuestAgentCommand) int { return strings.Compare(a.Name, b.Name) })
		return
	}

	var e *agent.Error
	if !errors.As(err, &e) {
		rd.fatal, rd.stop = err, true
		return
	}
	switch {
	case e.Reason == agent.NotConnected:
		rd.info.Agent.Connected = false
		rd.info.Agent.Message = "the guest agent is not connected: " + e.Message
		rd.stop = true
	case e.Reason == agent.NotResponding || (e.Reason == agent.Timeout && !rd.vm.Health().Healthy):
		msg := e.Message
		if e.Reason == agent.Timeout {
			msg = rd.vm.Health().Message
		}
		rd.info.Agent.Message = msg
		for _, s := range sections {
			rd.info.Errors = append(rd.info.Errors, v1alpha1.GuestInfoError{
				Section: s, Command: agent.CmdInfo, Reason: v1alpha1.ReasonNotResponding, Message: msg})
		}
		rd.stop = true
	default:
		rd.info.Agent.Message = fmt.Sprintf("guest-info failed (%s); the commands run without knowing which are enabled", e.Message)
	}
}

// run runs one command of a section and decodes its reply into out,
// records a failure in the answer's errors, and reports whether out holds
// the reply.
func (rd *reader) run(section string, cmd agent.Command, out any) bool {
	ok, e := rd.try(cmd, out)
	if e != nil {
		rd.fail(section, e)
	}
	return ok
}

// try runs one command, unless guest-info says not to, and decodes its
// reply into out. It returns true, or the agent's error, or neither when
// the call stops: the agent went away (connected: false) or the call
// cannot go on (fatal).
func (rd *reader) try(cmd agent.Command, out any) (bool, *agent.Error) {
	if rd.stop {
		return false, nil
	}
	if e := rd.gate(cmd.Name()); e != nil {
		return false, e
	}
	raw, err := rd.vm.Run(rd.ctx, cmd)
	if err != nil {
		var e *agent.Error
		switch {
		case !errors.As(err, &e):
			rd.fatal, rd.stop = err, true
			return false, nil
		case e.Reason == agent.NotConnected:
			rd.info.Agent.Connected = false
			rd.info.Agent.Message = "the guest agent is not connected: " + e.Message
			rd.stop = true
			return false, nil
		}
		return false, e
	}
	if err := decode(raw, out); err != nil {
		return false, &agent.Error{Command: cmd.Name(), Reason: agent.AgentError,
			Message: fmt.Sprintf("the agent's reply is not what %s returns: %v", cmd.Name(), err)}
	}
	return true, nil
}

func (rd *reader) fail(section string, e *agent.Error) {
	rd.info.Errors = append(rd.info.Errors, v1alpha1.GuestInfoError{
		Section: section, Command: e.Command, Reason: apiReason(e.Reason), Message: e.Message})
}

func apiReason(r agent.Reason) string {
	switch r {
	case agent.Blocked:
		return v1alpha1.ReasonBlocked
	case agent.NotSupported:
		return v1alpha1.ReasonNotSupported
	case agent.Timeout:
		return v1alpha1.ReasonTimeout
	case agent.NotResponding:
		return v1alpha1.ReasonNotResponding
	}
	return v1alpha1.ReasonAgentError
}

// since is the qemu-ga version that brought a command, where an agent still
// in use may predate it.
var since = map[string]string{
	agent.CmdGetLoad:              "10.0",
	agent.CmdNetworkGetRoute:      "9.1",
	agent.CmdGetCPUStats:          "7.1",
	agent.CmdGetDiskStats:         "7.1",
	agent.CmdGetDisks:             "5.2",
	agent.CmdGetDevices:           "5.2",
	agent.CmdSSHGetAuthorizedKeys: "5.2",
}

// Commands of one OS. Older agents list the other OS's commands as
// disabled: that is not the guest's configuration.
var (
	windowsOnly = []string{agent.CmdGetDevices}
	linuxOnly   = []string{agent.CmdGetCPUStats, agent.CmdGetDiskStats, agent.CmdGetMemoryBlocks}
)

// gate returns the error of a command guest-info says not to call.
func (rd *reader) gate(cmd string) *agent.Error {
	if rd.commands == nil {
		return nil
	}
	enabled, listed := rd.commands[cmd]
	switch {
	case !listed:
		msg := fmt.Sprintf("this guest agent (qemu-ga %s) does not have %s", rd.version, cmd)
		older, known := olderThan(rd.version, since[cmd])
		switch {
		case known && older:
			msg += fmt.Sprintf("; it needs qemu-ga %s or later", since[cmd])
		case rd.windows && slices.Contains(linuxOnly, cmd), !rd.windows && slices.Contains(windowsOnly, cmd):
			msg += "; it is not for this OS"
		}
		return &agent.Error{Command: cmd, Reason: agent.NotSupported, Message: msg}
	case !enabled && (rd.windows && slices.Contains(linuxOnly, cmd) || !rd.windows && slices.Contains(windowsOnly, cmd)):
		return &agent.Error{Command: cmd, Reason: agent.NotSupported,
			Message: fmt.Sprintf("%s is not for this OS (qemu-ga %s lists it as disabled)", cmd, rd.version)}
	case !enabled:
		return agent.BlockedError(cmd)
	}
	return nil
}

// olderThan compares two versions by major and minor: whether have is older
// than want, and whether both could be read.
func olderThan(have, want string) (older, known bool) {
	h, hok := majorMinor(have)
	w, wok := majorMinor(want)
	if !hok || !wok {
		return false, false
	}
	return h[0] < w[0] || h[0] == w[0] && h[1] < w[1], true
}

func majorMinor(v string) ([2]int, bool) {
	var out [2]int
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 2 {
		return out, false
	}
	for i := range out {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func (rd *reader) system() *v1alpha1.GuestSystem {
	if rd.info.System == nil {
		rd.info.System = &v1alpha1.GuestSystem{}
	}
	return rd.info.System
}

func (rd *reader) readSystem() {
	var hn struct {
		HostName string `json:"hostName"`
	}
	if rd.run(v1alpha1.SectionSystem, agent.GetHostName(), &hn) {
		rd.system().HostName = hn.HostName
	}
	var tz v1alpha1.GuestTimezone
	if rd.run(v1alpha1.SectionSystem, agent.GetTimezone(), &tz) {
		rd.system().Timezone = &tz
	}
}

func (rd *reader) readCPU() {
	cpu := &v1alpha1.GuestCPU{}
	ok := rd.run(v1alpha1.SectionCPU, agent.GetVCPUs(), &cpu.VCPUs)
	ok = rd.run(v1alpha1.SectionCPU, agent.GetCPUStats(), &cpu.Stats) || ok
	var load v1alpha1.GuestLoadAverage
	if rd.run(v1alpha1.SectionCPU, agent.GetLoad(), &load) {
		cpu.Load, ok = &load, true
	}
	if ok {
		rd.info.CPU = cpu
	}
}

func (rd *reader) readMemory() {
	mem := &v1alpha1.GuestMemory{}
	if rd.run(v1alpha1.SectionMemory, agent.GetMemoryBlocks(), &mem.Blocks) {
		rd.info.Memory = mem
	}
}

func (rd *reader) readDisks() {
	d := &v1alpha1.GuestDisks{}
	ok := rd.run(v1alpha1.SectionDisks, agent.GetDisks(), &d.Disks)
	ok = rd.run(v1alpha1.SectionDisks, agent.GetDiskStats(), &d.Stats) || ok
	ok = rd.run(v1alpha1.SectionDisks, agent.GetFSInfo(), &d.Filesystems) || ok
	if ok {
		rd.info.Disks = d
	}
}

func (rd *reader) readNetwork() {
	n := &v1alpha1.GuestNetwork{}
	ok := rd.run(v1alpha1.SectionNetwork, agent.NetworkGetInterfaces(), &n.Interfaces)
	ok = rd.run(v1alpha1.SectionNetwork, agent.NetworkGetRoute(), &n.Routes) || ok
	if ok {
		rd.info.Network = n
	}
}

// loggedIn reads guest-get-users once per call, for users and sshkeys,
// and reports its failure in the section.
func (rd *reader) loggedIn(section string) ([]v1alpha1.GuestUser, bool) {
	if !rd.usersRead {
		rd.usersRead = true
		var users []v1alpha1.GuestUser
		ok, e := rd.try(agent.GetUsers(), &users)
		if ok {
			rd.users = users
		}
		rd.usersErr = e
	}
	if rd.stop {
		return nil, false
	}
	if rd.usersErr != nil {
		rd.fail(section, rd.usersErr)
		return nil, false
	}
	return rd.users, true
}

func (rd *reader) readUsers() {
	users, ok := rd.loggedIn(v1alpha1.SectionUsers)
	if ok {
		rd.info.Users = &v1alpha1.GuestUsers{Items: nonNil(users)}
	}
}

func (rd *reader) readDevices() {
	var devs []v1alpha1.GuestDeviceInfo
	if rd.run(v1alpha1.SectionDevices, agent.GetDevices(), &devs) {
		rd.info.Devices = &v1alpha1.GuestDevices{Items: nonNil(devs)}
	}
}

// readSSHKeys reads the authorized keys of root (not on Windows), of the
// users the call named in sshUsers, and of the users logged in. The agent
// lists no other users; a client names a user only through sshUsers, which
// ParseSSHUsers checked.
func (rd *reader) readSSHKeys() {
	if e := rd.gate(agent.CmdSSHGetAuthorizedKeys); e != nil {
		rd.fail(v1alpha1.SectionSSHKeys, e)
		return
	}
	var names []string
	if !rd.windows {
		names = append(names, "root")
	}
	for _, u := range rd.sshUsers {
		if !slices.Contains(names, u) {
			names = append(names, u)
		}
	}
	users, ok := rd.loggedIn(v1alpha1.SectionSSHKeys)
	if rd.stop {
		return
	}
	if ok {
		for _, u := range users {
			if !slices.Contains(names, u.User) {
				names = append(names, u.User)
			}
		}
	}
	if len(names) > MaxSSHUsers {
		names = names[:MaxSSHUsers]
	}
	block := &v1alpha1.GuestSSHKeys{Users: []v1alpha1.GuestUserSSHKeys{}}
	for _, name := range names {
		entry := v1alpha1.GuestUserSSHKeys{Username: name, Keys: []string{}}
		cmd, err := agent.SSHGetAuthorizedKeys(name)
		if err != nil {
			entry.Reason, entry.Message = v1alpha1.ReasonAgentError, err.Error()
			block.Users = append(block.Users, entry)
			continue
		}
		var keys struct {
			Keys []string `json:"keys"`
		}
		ok, e := rd.try(cmd, &keys)
		switch {
		case ok:
			entry.Keys = nonNil(keys.Keys)
		case e == nil:
			return
		case e.Reason == agent.AgentError && noKeysFile(e.Message):
			// No authorized_keys file: no keys.
		default:
			entry.Reason, entry.Message = apiReason(e.Reason), e.Message
		}
		block.Users = append(block.Users, entry)
	}
	rd.info.SSHKeys = block
}

// noKeysFile reports whether guest-ssh-get-authorized-keys failed for a
// user with no authorized_keys file, which is no keys. A user the guest
// does not have fails too, and stays an error.
func noKeysFile(msg string) bool {
	return strings.Contains(msg, "No such file or directory") && !strings.Contains(msg, "failed to lookup user")
}

func (rd *reader) readTime() {
	before := rd.clock.Now()
	var ns int64
	if !rd.run(v1alpha1.SectionTime, agent.GetTime(), &ns) {
		return
	}
	after := rd.clock.Now()
	host := before.Add(after.Sub(before) / 2)
	guestTime := time.Unix(0, ns)
	rd.info.Time = &v1alpha1.GuestTime{
		GuestTime:    metav1.NewMicroTime(guestTime),
		HostTime:     metav1.NewMicroTime(host),
		DriftSeconds: guestTime.Sub(host).Seconds(),
	}
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
