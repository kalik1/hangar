package agent

import (
	"sync"
	"time"

	"k8s.io/utils/clock"
)

// DefaultProbeInterval is how often the bridge pings an agent that does not
// respond, instead of calling it.
const DefaultProbeInterval = 30 * time.Second

// Health is what the bridge knows of a VM's agent, from its own calls.
// KubeVirt's AgentConnected condition is never a source: it stays True on a
// broken agent.
type Health struct {
	// Healthy is false from a call that found the agent not responding
	// until a ping answers again.
	Healthy bool
	// Since is when the agent stopped responding.
	Since time.Time
	// Message is why, with the advice to restart the agent in the guest.
	Message string
	// NextCheck is when the next call pings the agent again; until then
	// calls fail at once with NotResponding.
	NextCheck time.Time
}

// health is the state machine behind Health:
//
//	healthy --(NotResponding, or a Timeout and a failed ping)--> not responding
//	not responding --(a call within the probe interval)--> refused, no agent I/O
//	not responding --(a call after it: one guest-ping)--> healthy if it answers
//	not responding --(the ping finds no agent connected)--> healthy
//
// The last edge is a restart of qemu-ga in the guest: libvirt drops its
// error state when the agent connects again.
type health struct {
	clock    clock.PassiveClock
	interval time.Duration

	mu        sync.Mutex
	down      bool
	since     time.Time
	lastProbe time.Time
	message   string
}

func newHealth(c clock.PassiveClock, interval time.Duration) *health {
	if c == nil {
		c = clock.RealClock{}
	}
	if interval <= 0 {
		interval = DefaultProbeInterval
	}
	return &health{clock: c, interval: interval}
}

type admission int

const (
	// admitCall: the agent is healthy, call it.
	admitCall admission = iota
	// admitProbe: the agent was not responding and the interval passed:
	// ping it first.
	admitProbe
	// admitRefuse: the agent is not responding: do not call it.
	admitRefuse
)

// admit decides what a call does. Of the calls that find the interval
// passed, only the first probes.
func (h *health) admit() admission {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.down {
		return admitCall
	}
	now := h.clock.Now()
	if now.Sub(h.lastProbe) < h.interval {
		return admitRefuse
	}
	h.lastProbe = now
	return admitProbe
}

// markDown records the agent as not responding, with why.
func (h *health) markDown(message string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.clock.Now()
	if !h.down {
		h.down = true
		h.since = now
	}
	h.lastProbe = now
	h.message = message
}

// markUp records the agent as responding again.
func (h *health) markUp() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.down = false
	h.since = time.Time{}
	h.lastProbe = time.Time{}
	h.message = ""
}

func (h *health) get() Health {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.down {
		return Health{Healthy: true}
	}
	return Health{Since: h.since, Message: h.message, NextCheck: h.lastProbe.Add(h.interval)}
}
