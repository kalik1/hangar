package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
	clocktesting "k8s.io/utils/clock/testing"
)

// fakeCaller answers each command with answer, and counts the calls and the
// most in flight at once.
type fakeCaller struct {
	mu       sync.Mutex
	answer   func(name string) (string, error)
	calls    []string
	inFlight atomic.Int32
	maxIn    atomic.Int32
}

func (f *fakeCaller) AgentCommand(domain, cmd string, _ time.Duration) (string, error) {
	n := f.inFlight.Add(1)
	defer f.inFlight.Add(-1)
	for {
		m := f.maxIn.Load()
		if n <= m || f.maxIn.CompareAndSwap(m, n) {
			break
		}
	}
	var c struct {
		Execute string `json:"execute"`
	}
	_ = json.Unmarshal([]byte(cmd), &c)
	f.mu.Lock()
	f.calls = append(f.calls, c.Execute)
	answer := f.answer
	f.mu.Unlock()
	if answer == nil {
		return `{"return":{}}`, nil
	}
	return answer(c.Execute)
}

func (f *fakeCaller) set(answer func(name string) (string, error)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer = answer
}

func (f *fakeCaller) take() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.calls
	f.calls = nil
	return c
}

var (
	errBroken = libvirt.Error{Code: uint32(libvirt.ErrAgentUnresponsive),
		Message: "Guest agent is not responding: QEMU guest agent is not available due to an error"}
	errNotConnected = libvirt.Error{Code: uint32(libvirt.ErrAgentUnresponsive),
		Message: "Guest agent is not responding: QEMU guest agent is not connected"}
	errTimeout = libvirt.Error{Code: uint32(libvirt.ErrAgentCommandTimeout),
		Message: "Guest agent didn't respond to command within timeout"}
)

func TestRunHealthy(t *testing.T) {
	f := &fakeCaller{}
	f.set(func(string) (string, error) { return `{"return":{"host-name":"fedora"}}`, nil })
	vm := NewVM("vms_vm", f, VMConfig{})
	ret, err := vm.Run(context.Background(), GetHostName())
	if err != nil || string(ret) != `{"host-name":"fedora"}` {
		t.Fatalf("%s, %v", ret, err)
	}
	if h := vm.Health(); !h.Healthy {
		t.Errorf("health %+v", h)
	}
	if got := f.take(); len(got) != 1 || got[0] != CmdGetHostName {
		t.Errorf("calls %v", got)
	}
}

// TestHealthStateMachine walks the edges of health's diagram.
func TestHealthStateMachine(t *testing.T) {
	clk := clocktesting.NewFakeClock(time.Date(2026, 11, 28, 4, 0, 0, 0, time.UTC))
	f := &fakeCaller{}
	vm := NewVM("vms_vm", f, VMConfig{Clock: clk})
	ctx := context.Background()
	run := func(step string, want Reason, wantCalls ...string) {
		t.Helper()
		_, err := vm.Run(ctx, GetOSInfo())
		if ReasonOf(err) != want {
			t.Errorf("%s: %v, want %q", step, err, want)
		}
		if got := f.take(); strings.Join(got, " ") != strings.Join(wantCalls, " ") {
			t.Errorf("%s: called %v, want %v", step, got, wantCalls)
		}
	}

	f.set(func(string) (string, error) { return "", errBroken })
	run("libvirt's error state", NotResponding, CmdGetOSInfo)
	h := vm.Health()
	if h.Healthy || !h.Since.Equal(clk.Now()) || !h.NextCheck.Equal(clk.Now().Add(30*time.Second)) ||
		!strings.Contains(h.Message, "not available due to an error") || !strings.Contains(h.Message, "systemctl restart qemu-guest-agent") {
		t.Errorf("health %+v", h)
	}
	since := h.Since

	clk.Step(29 * time.Second)
	run("refused within the interval: no agent I/O", NotResponding)
	clk.Step(time.Second)
	run("after 30 s: one ping, which fails", NotResponding, CmdPing)
	if h := vm.Health(); h.Healthy || !h.Since.Equal(since) || !h.NextCheck.Equal(clk.Now().Add(30*time.Second)) {
		t.Errorf("after a failed ping: %+v", h)
	}
	run("refused again", NotResponding)

	f.set(func(name string) (string, error) {
		if name == CmdPing {
			return "", errNotConnected
		}
		return `{"return":{}}`, nil
	})
	clk.Step(30 * time.Second)
	run("qemu-ga restarting: not connected, and healthy again", NotConnected, CmdPing)
	if !vm.Health().Healthy {
		t.Error("not healthy after the agent disconnected")
	}

	f.set(func(string) (string, error) { return "", errBroken })
	run("broken again", NotResponding, CmdGetOSInfo)
	f.set(nil)
	clk.Step(30 * time.Second)
	run("the ping answers: the command runs", "", CmdPing, CmdGetOSInfo)
	if !vm.Health().Healthy {
		t.Error("not healthy after a ping answered")
	}

	// A slow command: the ping answers, the agent stays healthy.
	f.set(func(name string) (string, error) {
		if name == CmdGetOSInfo {
			return "", errTimeout
		}
		return `{"return":{}}`, nil
	})
	run("a slow command", Timeout, CmdGetOSInfo, CmdPing)
	if !vm.Health().Healthy {
		t.Error("a slow command marked the agent down")
	}

	// A hung agent: the ping times out too.
	f.set(func(string) (string, error) { return "", errTimeout })
	run("a hung agent", Timeout, CmdGetOSInfo, CmdPing)
	if vm.Health().Healthy {
		t.Error("a hung agent is healthy")
	}
	run("then refused", NotResponding)
}

// TestOneCommandInFlight: concurrent calls reach libvirt one at a time,
// and a call the bridge stopped waiting for holds the next one back until
// libvirt answers it.
func TestOneCommandInFlight(t *testing.T) {
	release := make(chan struct{})
	f := &fakeCaller{}
	f.set(func(name string) (string, error) {
		if name == CmdGetFSInfo {
			<-release
		}
		time.Sleep(time.Millisecond)
		return `{"return":{}}`, nil
	})
	vm := NewVM("vms_vm", f, VMConfig{CallTimeout: 50 * time.Millisecond})

	start := time.Now()
	_, err := vm.Run(context.Background(), GetFSInfo())
	if ReasonOf(err) != Timeout || time.Since(start) > 2*time.Second {
		t.Fatalf("a stuck libvirt: %v after %s", err, time.Since(start))
	}
	// Its ping waited for the stuck call and timed out: down.
	if vm.Health().Healthy {
		t.Error("healthy while libvirt is stuck")
	}
	if got := f.take(); len(got) != 1 {
		t.Errorf("calls %v: the ping must wait for the stuck call", got)
	}
	close(release)

	f = &fakeCaller{}
	f.set(func(string) (string, error) {
		time.Sleep(time.Millisecond)
		return `{"return":{}}`, nil
	})
	vm = NewVM("vms_vm", f, VMConfig{})
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, err := vm.Run(context.Background(), GetTime()); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if m := f.maxIn.Load(); m != 1 {
		t.Errorf("%d commands in flight at once, want 1", m)
	}
}

func TestRunCanceled(t *testing.T) {
	f := &fakeCaller{}
	block := make(chan struct{})
	defer close(block)
	f.set(func(string) (string, error) { <-block; return `{"return":{}}`, nil })
	vm := NewVM("vms_vm", f, VMConfig{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()
	_, err := vm.Run(ctx, GetTime())
	if !errors.Is(err, context.Canceled) || ReasonOf(err) != "" {
		t.Errorf("%v, want the context's Canceled", err)
	}
	if !vm.Health().Healthy {
		t.Error("a caller that went away marked the agent down")
	}
}
