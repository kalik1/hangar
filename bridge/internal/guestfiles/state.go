package guestfiles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/kalik1/hangar/bridge/internal/agent"
)

// stateTTL is how long the bridge keeps what guest-info and
// guest-get-osinfo said of a VM's agent. A guest whose administrator enables
// the file commands (Rocky's drop-in) is served within it.
const stateTTL = 10 * time.Second

// vmState is what the bridge knows of a VM's agent for guestfiles.
type vmState struct {
	at time.Time
	// windows is the guest's OS, from guest-get-osinfo; osKnown is false
	// when the agent did not say.
	windows bool
	osKnown bool
	// commands are guest-info's commands and whether each is enabled; nil
	// when guest-info did not answer (the commands then run ungated).
	commands map[string]bool
	version  string
}

type states struct {
	mu sync.Mutex
	m  map[*agent.VM]*vmState
}

// state returns the VM's state, reading it again after stateTTL. Its error
// is the agent's when it cannot be reached at all.
func (h *Handler) state(ctx context.Context, vm *agent.VM) (*vmState, error) {
	now := h.clock.Now()
	h.states.mu.Lock()
	st := h.states.m[vm]
	h.states.mu.Unlock()
	if st != nil && now.Sub(st.at) < stateTTL {
		return st, nil
	}

	st = &vmState{at: now}
	ret, err := vm.Run(ctx, agent.Info())
	switch {
	case err == nil:
		var gi struct {
			Version  string `json:"version"`
			Commands []struct {
				Name    string `json:"name"`
				Enabled bool   `json:"enabled"`
			} `json:"supported_commands"`
		}
		if json.Unmarshal(ret, &gi) == nil {
			st.version = gi.Version
			st.commands = make(map[string]bool, len(gi.Commands))
			for _, c := range gi.Commands {
				st.commands[c.Name] = c.Enabled
			}
		}
	case unreachable(err):
		return nil, err
	}
	if st.commands == nil || st.commands[agent.CmdGetOSInfo] {
		ret, err := vm.Run(ctx, agent.GetOSInfo())
		switch {
		case err == nil:
			var os struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ret, &os) == nil && os.ID != "" {
				st.windows, st.osKnown = os.ID == "mswindows", true
			}
		case unreachable(err):
			return nil, err
		}
	}

	h.states.mu.Lock()
	defer h.states.mu.Unlock()
	if h.states.m == nil {
		h.states.m = map[*agent.VM]*vmState{}
	}
	for k, v := range h.states.m {
		if now.Sub(v.at) > 30*stateTTL {
			delete(h.states.m, k)
		}
	}
	h.states.m[vm] = st
	return st, nil
}

// forget drops what the bridge knows of the VM's agent: a command it took
// for enabled answered Blocked, say.
func (h *Handler) forget(vm *agent.VM) {
	h.states.mu.Lock()
	defer h.states.mu.Unlock()
	delete(h.states.m, vm)
}

// unreachable is an error after which no other command is worth sending.
func unreachable(err error) bool {
	var e *agent.Error
	if !errors.As(err, &e) {
		return true // the connection, the domain or the caller
	}
	switch e.Reason {
	case agent.NotConnected, agent.NotResponding, agent.Timeout:
		return true
	}
	return false
}

// gate returns the error of the first of cmds that guest-info says the
// bridge must not call: Blocked, naming every disabled one, or
// NotSupported.
func (st *vmState) gate(cmds ...string) error {
	if st.commands == nil {
		return nil
	}
	var blocked []string
	for _, c := range cmds {
		enabled, listed := st.commands[c]
		switch {
		case !listed:
			return &agent.Error{Command: c, Reason: agent.NotSupported,
				Message: fmt.Sprintf("this guest agent (qemu-ga %s) does not have %s", st.version, c)}
		case !enabled:
			blocked = append(blocked, c)
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	e := agent.BlockedError(blocked[0])
	if len(blocked) > 1 {
		e.Message = strings.Replace(e.Message, blocked[0], strings.Join(blocked, ", "), 1)
	}
	return e
}

// can reports whether guest-info lets the bridge call every one of cmds.
func (st *vmState) can(cmds ...string) bool { return st.gate(cmds...) == nil }

// The commands of each kind of operation.
var (
	execCommands  = []string{agent.CmdExec, agent.CmdExecStatus}
	readCommands  = []string{agent.CmdFileOpen, agent.CmdFileSeek, agent.CmdFileRead, agent.CmdFileClose}
	writeCommands = []string{agent.CmdFileOpen, agent.CmdFileSeek, agent.CmdFileWrite, agent.CmdFileClose}
	pageCommands  = []string{agent.CmdExec, agent.CmdExecStatus, agent.CmdFileOpen, agent.CmdFileSeek, agent.CmdFileRead, agent.CmdFileClose}
)
