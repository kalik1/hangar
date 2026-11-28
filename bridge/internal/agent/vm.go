package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"k8s.io/utils/clock"
)

// The timings of agent calls, measured by the prototype: a command takes
// 4-5 ms, two round trips with libvirt's guest-sync.
const (
	// DefaultAgentTimeout is the timeout libvirt gets for each agent
	// command.
	DefaultAgentTimeout = 5 * time.Second
	// DefaultCallTimeout bounds a call on the bridge's side: libvirt's
	// guest-sync, its wait for the domain's agent job (KubeVirt's poller
	// may hold it), and the command.
	DefaultCallTimeout = 10 * time.Second
)

// Caller sends agent commands to a domain: a libvirt connection, or a fake
// in tests.
type Caller interface {
	// AgentCommand runs one agent command (JSON) on the domain through
	// virDomainQemuAgentCommand, with libvirt's agent timeout, and returns
	// the agent's reply (JSON). It blocks until libvirt answers.
	AgentCommand(domain, cmd string, timeout time.Duration) (string, error)
}

// VMConfig sets a VM's timings; zero values are the defaults.
type VMConfig struct {
	AgentTimeout  time.Duration
	CallTimeout   time.Duration
	ProbeInterval time.Duration
	Clock         clock.PassiveClock
}

// VM is one VM's guest agent, as the bridge calls it: one command at a time,
// each with a timeout, and none while the agent does not respond but one
// ping per probe interval.
type VM struct {
	domain       string
	caller       Caller
	agentTimeout time.Duration
	callTimeout  time.Duration
	health       *health
	// sem holds one agent command in flight. A command the bridge stopped
	// waiting for keeps it until libvirt answers, so the bridge never
	// queues a second job behind a stuck one.
	sem chan struct{}
}

// NewVM returns the agent of the libvirt domain (namespace_name) that caller
// reaches.
func NewVM(domain string, caller Caller, cfg VMConfig) *VM {
	if cfg.AgentTimeout <= 0 {
		cfg.AgentTimeout = DefaultAgentTimeout
	}
	if cfg.CallTimeout <= 0 {
		cfg.CallTimeout = DefaultCallTimeout
	}
	return &VM{
		domain:       domain,
		caller:       caller,
		agentTimeout: cfg.AgentTimeout,
		callTimeout:  cfg.CallTimeout,
		health:       newHealth(cfg.Clock, cfg.ProbeInterval),
		sem:          make(chan struct{}, 1),
	}
}

// Domain is the libvirt domain's name.
func (v *VM) Domain() string { return v.domain }

// Health is the agent's health, from the bridge's own calls.
func (v *VM) Health() Health { return v.health.get() }

// Run runs one command and returns the agent's "return" value.
//
// Its error is an *Error (see Reason), ErrConnectionLost, ErrNoDomain, or
// the context's Canceled when the caller went away. While the agent does
// not respond, Run fails at once with NotResponding, but for one guest-ping
// per probe interval; a NotResponding error, or a Timeout that a ping
// confirms, marks the agent so.
func (v *VM) Run(ctx context.Context, cmd Command) (json.RawMessage, error) {
	switch v.health.admit() {
	case admitRefuse:
		return nil, v.notResponding(cmd.Name())
	case admitProbe:
		ret, err := v.call(ctx, Ping())
		switch {
		case err == nil:
			v.health.markUp()
		case ReasonOf(err) == NotConnected:
			// qemu-ga restarting: libvirt drops its error state when
			// the agent connects again.
			v.health.markUp()
			return nil, retag(err, cmd.Name())
		case ReasonOf(err) == NotResponding || ReasonOf(err) == Timeout:
			v.health.markDown(downMessage(err))
			return nil, v.notResponding(cmd.Name())
		default:
			return nil, err
		}
		if cmd.Name() == CmdPing {
			return ret, nil
		}
	}

	ret, err := v.call(ctx, cmd)
	switch ReasonOf(err) {
	case NotResponding:
		v.health.markDown(downMessage(err))
		return nil, v.notResponding(cmd.Name())
	case Timeout:
		if cmd.Name() == CmdPing {
			v.health.markDown(downMessage(err))
			return nil, v.notResponding(cmd.Name())
		}
		// A slow command (guest-get-fsinfo on a hung NFS mount, say) or a
		// hung agent: a ping tells.
		if _, perr := v.call(ctx, Ping()); perr != nil && (ReasonOf(perr) == NotResponding || ReasonOf(perr) == Timeout) {
			v.health.markDown(downMessage(perr))
		}
	}
	return ret, err
}

// call sends one command, one at a time per VM, and waits for libvirt's
// answer up to the call timeout.
func (v *VM) call(ctx context.Context, cmd Command) (json.RawMessage, error) {
	body, err := json.Marshal(cmd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, v.callTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, v.contextError(ctx, cmd.Name(), "the call's time is up")
	}

	select {
	case v.sem <- struct{}{}:
	case <-ctx.Done():
		return nil, v.contextError(ctx, cmd.Name(), "the previous agent command is still running")
	}
	type result struct {
		reply string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		defer func() { <-v.sem }()
		reply, err := v.caller.AgentCommand(v.domain, string(body), v.agentTimeout)
		done <- result{reply, err}
	}()

	select {
	case r := <-done:
		if r.err != nil {
			return nil, classify(cmd.Name(), r.err)
		}
		return parseReply(cmd.Name(), r.reply)
	case <-ctx.Done():
		return nil, v.contextError(ctx, cmd.Name(), "libvirt did not answer")
	}
}

func (v *VM) contextError(ctx context.Context, cmd, what string) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return ctx.Err()
	}
	return &Error{Command: cmd, Reason: Timeout, Err: ctx.Err(),
		Message: fmt.Sprintf("no answer within %s: %s", v.callTimeout, what)}
}

func (v *VM) notResponding(cmd string) *Error {
	h := v.health.get()
	msg := h.Message
	if msg == "" {
		msg = "the guest agent is not responding. " + NotRespondingAdvice
	}
	if !h.NextCheck.IsZero() {
		msg += fmt.Sprintf(" The bridge checks it again at %s.", h.NextCheck.UTC().Format(time.RFC3339))
	}
	return &Error{Command: cmd, Reason: NotResponding, Message: msg}
}

func downMessage(err error) string {
	var e *Error
	detail := err.Error()
	if errors.As(err, &e) {
		detail = e.Message
	}
	return fmt.Sprintf("the guest agent is not responding (%s). %s", detail, NotRespondingAdvice)
}

// retag returns err as the error of another command.
func retag(err error, cmd string) error {
	var e *Error
	if errors.As(err, &e) {
		c := *e
		c.Command = cmd
		return &c
	}
	return err
}
