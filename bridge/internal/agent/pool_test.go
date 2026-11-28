package agent

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"

	"github.com/kalik1/hangar/bridge/internal/fakelibvirt"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/launcher"
)

const (
	podA = types.UID("3f1c2a7e-8b5d-4c1e-9a0f-1b2c3d4e5f60")
	podB = types.UID("9d8e7f6a-5b4c-4d3e-8f2a-0b1c2d3e4f50")
)

func target(pods ...types.UID) guest.Target {
	return guest.Target{Namespace: "vms", Name: "fedora", Phase: "Running", Node: "node-a", Pods: pods}
}

// startLauncher serves a fake virtqemud in a pod's runtime directory under
// pods; it runs the domains given and answers guest-get-host-name with the
// pod's UID.
func startLauncher(t *testing.T, pods string, pod types.UID, domains ...string) *fakelibvirt.Server {
	t.Helper()
	dir, err := fakelibvirt.MkRuntimeDir(pods, string(pod), launcher.RuntimeDir)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir, launcher.SocketName)) // a previous launcher's
	s := &fakelibvirt.Server{Domains: domains, Agent: func(_, cmd string) (string, *fakelibvirt.Error) {
		if strings.Contains(cmd, CmdGetHostName) {
			return `{"return":{"host-name":"` + string(pod) + `"}}`, nil
		}
		return `{"return":{}}`, nil
	}}
	if err := s.Listen(dir, launcher.SocketName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func newPool(pods string) *Pool {
	d := &launcher.Dialer{PodsDir: pods}
	return NewPool(PoolConfig{Dial: d.Dial, ConnectTimeout: time.Second})
}

func hostName(t *testing.T, p *Pool, tg guest.Target) (string, error) {
	t.Helper()
	vm, err := p.VM(context.Background(), tg)
	if err != nil {
		return "", err
	}
	ret, err := vm.Run(context.Background(), GetHostName())
	return string(ret), err
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func statusCode(err error) int32 {
	if s, ok := err.(apierrors.APIStatus); ok {
		return s.Status().Code
	}
	return 0
}

// TestPoolOneConnection: many calls, concurrent ones included, share one
// libvirt connection per launcher, with the go-libvirt client over the
// fake's socket.
func TestPoolOneConnection(t *testing.T) {
	pods := t.TempDir()
	s := startLauncher(t, pods, podA, "vms_fedora")
	p := newPool(pods)
	defer p.Close()

	var wg sync.WaitGroup
	for range 30 {
		wg.Go(func() {
			got, err := hostName(t, p, target(podA))
			if err != nil || got != `{"host-name":"`+string(podA)+`"}` {
				t.Errorf("%s, %v", got, err)
			}
		})
	}
	wg.Wait()
	if n := s.Accepted(); n != 1 {
		t.Errorf("%d connections, want 1", n)
	}
	calls := s.Calls()
	if len(calls) != 30 || calls[0].Domain != "vms_fedora" || calls[0].Timeout != 5 ||
		calls[0].Cmd != `{"execute":"guest-get-host-name"}` {
		t.Errorf("calls: %d, first %+v", len(calls), calls[0])
	}
}

// TestPoolPicksThePod: around a migration two launcher pods may be listed;
// the VM is the one whose libvirt runs the domain.
func TestPoolPicksThePod(t *testing.T) {
	pods := t.TempDir()
	startLauncher(t, pods, podA)
	startLauncher(t, pods, podB, "vms_fedora")
	p := newPool(pods)
	defer p.Close()
	got, err := hostName(t, p, target(podA, podB))
	if err != nil || !strings.Contains(got, string(podB)) {
		t.Errorf("%s, %v; want pod B's", got, err)
	}

	_, err = hostName(t, p, target(podA))
	if statusCode(err) != http.StatusServiceUnavailable || !strings.Contains(err.Error(), "vms_fedora") {
		t.Errorf("a launcher without the domain: %v", err)
	}
}

// TestPoolLauncherGoes: the launcher stops, then a new one starts; and a
// virtqemud that drops its connections. The pool drops a dead connection
// and dials again.
func TestPoolLauncherGoes(t *testing.T) {
	pods := t.TempDir()
	s := startLauncher(t, pods, podA, "vms_fedora")
	p := newPool(pods)
	defer p.Close()
	vm, err := p.VM(context.Background(), target(podA))
	if err != nil {
		t.Fatal(err)
	}

	s.Close()
	eventually(t, "the pool to drop the connection", func() bool { return p.Len() == 0 })
	_, err = vm.Run(context.Background(), GetHostName())
	if statusCode(StatusError(err)) != http.StatusServiceUnavailable {
		t.Errorf("a call on the gone launcher: %v", err)
	}
	_, err = p.VM(context.Background(), target(podA))
	if statusCode(err) != http.StatusServiceUnavailable {
		t.Errorf("no launcher: %v", err)
	} else if s := err.(apierrors.APIStatus).Status(); s.Details == nil || s.Details.RetryAfterSeconds == 0 {
		t.Errorf("no Retry-After: %+v", s)
	}

	s2 := startLauncher(t, pods, podA, "vms_fedora")
	if _, err := hostName(t, p, target(podA)); err != nil {
		t.Fatalf("after the launcher came back: %v", err)
	}
	s2.DropConnections()
	eventually(t, "the pool to drop the connection", func() bool { return p.Len() == 0 })
	if _, err := hostName(t, p, target(podA)); err != nil {
		t.Fatalf("after virtqemud dropped the connection: %v", err)
	}
	if n := s2.Accepted(); n != 2 {
		t.Errorf("%d connections, want 2", n)
	}
}

func TestPoolErrors(t *testing.T) {
	pods := t.TempDir()
	p := newPool(pods)
	defer p.Close()

	if _, err := p.VM(context.Background(), target()); statusCode(err) != http.StatusServiceUnavailable {
		t.Errorf("no pod: %v", err)
	}
	if _, err := p.VM(context.Background(), target(podA)); statusCode(err) != http.StatusServiceUnavailable {
		t.Errorf("no socket: %v", err)
	}

	// A runtime directory that is a link: refused, 500.
	elsewhere := t.TempDir()
	startLauncher(t, elsewhere, podB, "vms_fedora")
	parent := filepath.Join(pods, string(podB), filepath.Dir(launcher.RuntimeDir))
	if err := os.MkdirAll(parent, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(elsewhere, string(podB), launcher.RuntimeDir), filepath.Join(parent, "libvirt-runtime")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.VM(context.Background(), target(podB)); statusCode(err) != http.StatusInternalServerError {
		t.Errorf("a link: %v", err)
	}

	// A launcher that never answers the handshake.
	dir, _ := fakelibvirt.MkRuntimeDir(pods, "mute", launcher.RuntimeDir)
	ln, err := fakelibvirt.ListenUnix(dir, launcher.SocketName)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	start := time.Now()
	if _, err := p.VM(context.Background(), target("mute")); statusCode(err) != http.StatusServiceUnavailable || !strings.Contains(err.Error(), "handshake") {
		t.Errorf("a mute launcher: %v", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("the handshake timeout took %s", d)
	}
	if p.Len() != 0 {
		t.Errorf("%d connections left after failed connects", p.Len())
	}
}

func TestPoolClose(t *testing.T) {
	pods := t.TempDir()
	s := startLauncher(t, pods, podA, "vms_fedora")
	p := newPool(pods)
	if _, err := hostName(t, p, target(podA)); err != nil {
		t.Fatal(err)
	}
	p.Close()
	eventually(t, "the launcher to see the connection closed", func() bool { return s.Open() == 0 })
	if _, err := p.VM(context.Background(), target(podA)); statusCode(err) != http.StatusServiceUnavailable {
		t.Errorf("after Close: %v", err)
	}
}
