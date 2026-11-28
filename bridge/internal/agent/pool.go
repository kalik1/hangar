package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
	"github.com/digitalocean/go-libvirt/socket/dialers"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/klog/v2"

	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/launcher"
)

// SessionURI is the libvirt URI of a non-root launcher's virtqemud.
const SessionURI = "qemu:///session"

// DefaultConnectTimeout bounds the dial and libvirt's handshake.
const DefaultConnectTimeout = 5 * time.Second

// DomainName is KubeVirt's libvirt domain of a VMI: namespace_name.
func DomainName(namespace, name string) string { return namespace + "_" + name }

// PoolConfig configures a Pool.
type PoolConfig struct {
	// Dial connects to the virtqemud of a launcher pod on this node (see
	// launcher.Dialer).
	Dial func(pod types.UID) (net.Conn, error)
	// ConnectTimeout bounds the dial and the handshake; zero is
	// DefaultConnectTimeout.
	ConnectTimeout time.Duration
	// VM sets the timings of each VM's calls.
	VM VMConfig
}

// Pool keeps one long-lived libvirt connection per virt-launcher pod on this
// node, and the VMs reached through them.
//
// A connection stays open until its launcher goes away or the pool closes:
// every disconnect logs an error line in the launcher's log. A VM's health
// lives as long as its connection.
type Pool struct {
	cfg PoolConfig

	mu     sync.Mutex
	closed bool
	conns  map[types.UID]*conn
}

// NewPool returns an empty pool.
func NewPool(cfg PoolConfig) *Pool {
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = DefaultConnectTimeout
	}
	return &Pool{cfg: cfg, conns: map[types.UID]*conn{}}
}

// VM returns the agent of the target VMI, through the libvirt of its
// launcher pod on this node. With several pods (around a migration), it is
// the one whose libvirt runs the domain.
//
// Its errors are API errors: 503 while the launcher or its domain is not
// there yet, or is going away; 500 for a path the bridge refuses.
func (p *Pool) VM(ctx context.Context, t guest.Target) (*VM, error) {
	domain := DomainName(t.Namespace, t.Name)
	var errs []error
	for _, pod := range t.Pods {
		c, err := p.conn(ctx, pod)
		if err == nil {
			var vm *VM
			if vm, err = c.vm(ctx, domain, p.cfg.VM); err == nil {
				return vm, nil
			}
			if errors.Is(err, ErrConnectionLost) {
				p.drop(c)
			}
		}
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		errs = append(errs, fmt.Errorf("pod %s: %w", pod, err))
	}
	if len(errs) == 0 {
		return nil, unavailable(fmt.Sprintf("virtualmachineinstance %s has no launcher pod on this node", t))
	}
	err := errors.Join(errs...)
	if errors.Is(err, launcher.ErrUnsafePath) {
		klog.ErrorS(err, "Refused the path to a launcher's libvirt", "vmi", t.String())
		return nil, apierrors.NewInternalError(fmt.Errorf("reaching the virtual machine's libvirt: %w", err))
	}
	return nil, unavailable(fmt.Sprintf("cannot reach the libvirt of virtualmachineinstance %s yet: %s", t, oneLine(err)))
}

// StatusError returns err of a VM's call as an API error, for the errors
// that end a call before the agent answered: ErrConnectionLost and
// ErrNoDomain are 503, a canceled context is passed on, anything else is
// 500. An *Error is not one of them: the agent's answer is data.
func StatusError(err error) error {
	switch {
	case errors.Is(err, ErrConnectionLost), errors.Is(err, ErrNoDomain):
		return unavailable(oneLine(err) + "; try again")
	case errors.Is(err, context.Canceled):
		return err
	}
	var api apierrors.APIStatus
	if errors.As(err, &api) {
		return err
	}
	return apierrors.NewInternalError(err)
}

func unavailable(msg string) error {
	err := apierrors.NewServiceUnavailable(msg)
	err.ErrStatus.Details = &metav1.StatusDetails{RetryAfterSeconds: 2}
	return err
}

func oneLine(err error) string { return strings.ReplaceAll(err.Error(), "\n", "; ") }

// Close disconnects every connection.
func (p *Pool) Close() {
	p.mu.Lock()
	p.closed = true
	conns := p.conns
	p.conns = map[types.UID]*conn{}
	p.mu.Unlock()
	var wg sync.WaitGroup
	for _, c := range conns {
		wg.Go(c.close)
	}
	wg.Wait()
}

// Len is the number of connections, open or opening.
func (p *Pool) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.conns)
}

// conn returns the pod's connection, dialling it if there is none. Callers
// that come while it is dialled wait for it.
func (p *Pool) conn(ctx context.Context, pod types.UID) (*conn, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, errors.New("the guest bridge is stopping")
	}
	c, ok := p.conns[pod]
	if !ok {
		c = &conn{pod: pod, ready: make(chan struct{}), domains: map[string]libvirt.Domain{}, vms: map[string]*VM{}}
		p.conns[pod] = c
		go p.connect(c)
	}
	p.mu.Unlock()

	select {
	case <-c.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if c.err != nil {
		return nil, c.err
	}
	return c, nil
}

// connect dials the pod's libvirt and opens the session. A failed connect
// leaves the pool, so the next call dials again.
func (p *Pool) connect(c *conn) {
	defer close(c.ready)
	raw, err := p.cfg.Dial(c.pod)
	if err != nil {
		c.err = err
		p.drop(c)
		return
	}
	l := libvirt.NewWithDialer(dialers.NewAlreadyConnected(&limitConn{Conn: raw}))
	done := make(chan error, 1)
	go func() { done <- l.ConnectToURI(libvirt.ConnectURI(SessionURI)) }()
	select {
	case err = <-done:
	case <-time.After(p.cfg.ConnectTimeout):
		_ = raw.Close()
		<-done
		err = fmt.Errorf("libvirt did not answer the handshake within %s", p.cfg.ConnectTimeout)
	}
	if err != nil {
		_ = raw.Close()
		c.err = fmt.Errorf("opening %s: %w", SessionURI, err)
		p.drop(c)
		return
	}
	c.raw, c.l = raw, l
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		c.err = errors.New("the guest bridge is stopping")
		go c.close()
		return
	}
	klog.V(2).InfoS("Connected to a launcher's libvirt", "pod", c.pod)
	disconnected := l.Disconnected()
	go func() {
		<-disconnected
		klog.V(2).InfoS("The connection to a launcher's libvirt ended", "pod", c.pod)
		p.drop(c)
	}()
}

// drop removes c from the pool, if it is still the pod's connection, and
// closes it.
func (p *Pool) drop(c *conn) {
	p.mu.Lock()
	if p.conns[c.pod] == c {
		delete(p.conns, c.pod)
	}
	p.mu.Unlock()
	if c.l != nil {
		go c.close()
	}
}

// conn is one launcher's libvirt connection.
type conn struct {
	pod types.UID
	// ready is closed when the connect is done; err is its error.
	ready chan struct{}
	err   error
	raw   net.Conn
	l     *libvirt.Libvirt

	mu      sync.Mutex
	domains map[string]libvirt.Domain
	vms     map[string]*VM
	closed  bool
}

// vm returns the domain's VM, looking the domain up once.
func (c *conn) vm(ctx context.Context, domain string, cfg VMConfig) (*VM, error) {
	c.mu.Lock()
	vm, ok := c.vms[domain]
	c.mu.Unlock()
	if ok {
		return vm, nil
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.lookup(domain)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			return nil, classify("", err)
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if vm, ok := c.vms[domain]; ok {
		return vm, nil
	}
	vm = NewVM(domain, c, cfg)
	c.vms[domain] = vm
	return vm, nil
}

func (c *conn) lookup(domain string) (libvirt.Domain, error) {
	c.mu.Lock()
	dom, ok := c.domains[domain]
	c.mu.Unlock()
	if ok {
		return dom, nil
	}
	dom, err := c.l.DomainLookupByName(domain)
	if err != nil {
		return libvirt.Domain{}, err
	}
	c.mu.Lock()
	c.domains[domain] = dom
	c.mu.Unlock()
	return dom, nil
}

// AgentCommand implements Caller with virDomainQemuAgentCommand.
func (c *conn) AgentCommand(domain, cmd string, timeout time.Duration) (string, error) {
	dom, err := c.lookup(domain)
	if err != nil {
		return "", err
	}
	seconds := int32(timeout / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	res, err := c.l.QEMUDomainAgentCommand(dom, cmd, seconds, 0)
	if err != nil {
		if libvirt.IsNotFound(err) {
			c.mu.Lock()
			delete(c.domains, domain)
			delete(c.vms, domain)
			c.mu.Unlock()
		}
		return "", err
	}
	if len(res) == 0 {
		return "", errors.New("libvirt returned no agent reply")
	}
	return res[0], nil
}

// close ends the session, or the socket if libvirt does not answer.
func (c *conn) close() {
	c.mu.Lock()
	if c.closed || c.l == nil {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	done := make(chan struct{})
	go func() {
		_ = c.l.Disconnect()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
	_ = c.raw.Close()
}
