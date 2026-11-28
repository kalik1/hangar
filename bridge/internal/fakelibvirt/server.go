// Package fakelibvirt is a stand-in for a virt-launcher's virtqemud, for
// tests: it speaks the part of libvirt's RPC protocol the bridge uses (the
// handshake, domain lookups and QEMU agent commands) on a real unix socket,
// and answers agent commands with a function the test gives.
package fakelibvirt

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync"

	"golang.org/x/sys/unix"
)

// libvirt's RPC programs and procedures.
const (
	remoteProgram = 0x20008086
	qemuProgram   = 0x20008087

	procConnectOpen        = 1
	procConnectClose       = 2
	procDomainLookupByName = 23
	procAuthList           = 66
	qemuProcAgentCommand   = 3

	typeReply   = 1
	statusOK    = 0
	statusError = 1
)

// libvirt error codes the tests use.
const (
	ErrInternalError       = 1
	ErrNoDomain            = 42
	ErrOperationInvalid    = 55
	ErrAgentUnresponsive   = 86
	ErrAgentCommandTimeout = 112
	ErrAgentCommandFailed  = 113
)

// Error is a libvirt error the fake answers with.
type Error struct {
	Code    uint32
	Message string
}

func (e *Error) Error() string { return e.Message }

// AgentFunc answers one agent command: the agent's reply (JSON), or a
// libvirt error. It may block, as a hung agent does.
type AgentFunc func(domain, cmd string) (string, *Error)

// Call is one agent command the fake received.
type Call struct {
	Domain  string
	Cmd     string
	Timeout int32
}

// Server is a fake virtqemud.
type Server struct {
	// Domains are the domains it runs, as namespace_name.
	Domains []string
	// Agent answers agent commands. Once the server listens, change it
	// with SetAgent.
	Agent AgentFunc

	ln net.Listener

	mu       sync.Mutex
	calls    []Call
	conns    map[net.Conn]struct{}
	accepted int
}

// Listen serves on dir/name. dir may be longer than a unix socket address
// allows: the fake binds through /proc/self/fd, as the bridge dials.
func (s *Server) Listen(dir, name string) error {
	ln, err := ListenUnix(dir, name)
	if err != nil {
		return err
	}
	s.ln = ln
	s.conns = map[net.Conn]struct{}{}
	go s.serve()
	return nil
}

// Close stops listening and drops every connection, as a launcher that
// goes away.
func (s *Server) Close() {
	if s.ln != nil {
		_ = s.ln.Close()
	}
	s.DropConnections()
}

// DropConnections closes the open connections and keeps listening, as a
// virtqemud that restarted.
func (s *Server) DropConnections() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		_ = c.Close()
	}
}

// SetAgent replaces the function that answers agent commands.
func (s *Server) SetAgent(f AgentFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Agent = f
}

// Calls returns the agent commands received so far.
func (s *Server) Calls() []Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Call(nil), s.calls...)
}

// Accepted is the number of connections accepted so far.
func (s *Server) Accepted() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accepted
}

// Open is the number of connections open.
func (s *Server) Open() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.conns)
}

func (s *Server) serve() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[c] = struct{}{}
		s.accepted++
		s.mu.Unlock()
		go s.handle(c)
	}
}

type header struct {
	program, version, procedure, typ uint32
	serial                           int32
	status                           uint32
}

func (s *Server) handle(c net.Conn) {
	defer func() {
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
		_ = c.Close()
	}()
	var wmu sync.Mutex
	write := func(h header, status uint32, payload []byte) {
		var b bytes.Buffer
		_ = binary.Write(&b, binary.BigEndian, uint32(28+len(payload)))
		for _, v := range []uint32{h.program, h.version, h.procedure, typeReply, uint32(h.serial), status} {
			_ = binary.Write(&b, binary.BigEndian, v)
		}
		b.Write(payload)
		wmu.Lock()
		defer wmu.Unlock()
		_, _ = c.Write(b.Bytes())
	}
	for {
		var size uint32
		if err := binary.Read(c, binary.BigEndian, &size); err != nil {
			return
		}
		if size < 28 || size > 8<<20 {
			return
		}
		buf := make([]byte, size-4)
		if _, err := io.ReadFull(c, buf); err != nil {
			return
		}
		var f [6]uint32
		for i := range f {
			f[i] = binary.BigEndian.Uint32(buf[i*4:])
		}
		h := header{program: f[0], version: f[1], procedure: f[2], typ: f[3], serial: int32(f[4]), status: f[5]}
		payload := buf[24:]

		switch {
		case h.program == remoteProgram && h.procedure == procAuthList:
			write(h, statusOK, u32(1, 0)) // one type: none
		case h.program == remoteProgram && h.procedure == procConnectOpen:
			write(h, statusOK, nil)
		case h.program == remoteProgram && h.procedure == procConnectClose:
			write(h, statusOK, nil)
			return
		case h.program == remoteProgram && h.procedure == procDomainLookupByName:
			name, _, err := readString(payload)
			if err != nil {
				return
			}
			if !s.hasDomain(name) {
				write(h, statusError, errorPayload(&Error{Code: ErrNoDomain, Message: fmt.Sprintf("Domain not found: no domain with matching name '%s'", name)}))
				continue
			}
			write(h, statusOK, domainPayload(name))
		case h.program == qemuProgram && h.procedure == qemuProcAgentCommand:
			// The agent may block: answer from a goroutine, as libvirt's
			// workers do.
			go func(h header, payload []byte) {
				call, err := readAgentCommand(payload)
				if err != nil {
					write(h, statusError, errorPayload(&Error{Code: ErrInternalError, Message: err.Error()}))
					return
				}
				s.mu.Lock()
				s.calls = append(s.calls, call)
				s.mu.Unlock()
				if !s.hasDomain(call.Domain) {
					write(h, statusError, errorPayload(&Error{Code: ErrNoDomain, Message: "Domain not found"}))
					return
				}
				s.mu.Lock()
				agent := s.Agent
				s.mu.Unlock()
				reply, aerr := agent(call.Domain, call.Cmd)
				if aerr != nil {
					write(h, statusError, errorPayload(aerr))
					return
				}
				var b bytes.Buffer
				b.Write(u32(1)) // the optional string is present
				b.Write(xdrString(reply))
				write(h, statusOK, b.Bytes())
			}(h, payload)
		default:
			write(h, statusError, errorPayload(&Error{Code: ErrInternalError, Message: "unknown procedure"}))
		}
	}
}

func (s *Server) hasDomain(name string) bool {
	for _, d := range s.Domains {
		if d == name {
			return true
		}
	}
	return false
}

func u32(vs ...uint32) []byte {
	b := make([]byte, 4*len(vs))
	for i, v := range vs {
		binary.BigEndian.PutUint32(b[i*4:], v)
	}
	return b
}

func xdrString(s string) []byte {
	pad := (4 - len(s)%4) % 4
	b := make([]byte, 4+len(s)+pad)
	binary.BigEndian.PutUint32(b, uint32(len(s)))
	copy(b[4:], s)
	return b
}

func readString(b []byte) (string, []byte, error) {
	if len(b) < 4 {
		return "", nil, errors.New("short string")
	}
	n := int(binary.BigEndian.Uint32(b))
	pad := (4 - n%4) % 4
	if len(b) < 4+n+pad {
		return "", nil, errors.New("short string")
	}
	return string(b[4 : 4+n]), b[4+n+pad:], nil
}

// domainPayload is remote_nonnull_domain: the name, a UUID and an ID.
func domainPayload(name string) []byte {
	var b bytes.Buffer
	b.Write(xdrString(name))
	b.Write(bytes.Repeat([]byte{0xab}, 16))
	b.Write(u32(1))
	return b.Bytes()
}

// readAgentCommand decodes qemu_domain_agent_command_args.
func readAgentCommand(b []byte) (Call, error) {
	name, rest, err := readString(b)
	if err != nil {
		return Call{}, err
	}
	if len(rest) < 20 {
		return Call{}, errors.New("short domain")
	}
	rest = rest[20:] // UUID and ID
	cmd, rest, err := readString(rest)
	if err != nil {
		return Call{}, err
	}
	if len(rest) < 8 {
		return Call{}, errors.New("short arguments")
	}
	return Call{Domain: name, Cmd: cmd, Timeout: int32(binary.BigEndian.Uint32(rest))}, nil
}

// errorPayload is remote_error.
func errorPayload(e *Error) []byte {
	var b bytes.Buffer
	b.Write(u32(e.Code, 10)) // code, domain (VIR_FROM_QEMU)
	b.Write(u32(1))          // message present
	b.Write(xdrString(e.Message))
	b.Write(u32(2))          // level: error
	b.Write(u32(0, 0, 0, 0)) // no domain, str1, str2, str3
	b.Write(u32(0, 0, 0))    // int1, int2, no network
	return b.Bytes()
}

// ListenUnix listens on a unix socket dir/name, through /proc/self/fd so
// that dir may be longer than a socket address allows. The socket file stays
// when the listener closes, as a dead launcher's does.
func ListenUnix(dir, name string) (*net.UnixListener, error) {
	fd, err := unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	ln, err := net.Listen("unix", "/proc/self/fd/"+strconv.Itoa(fd)+"/"+name)
	if err != nil {
		return nil, err
	}
	ul := ln.(*net.UnixListener)
	ul.SetUnlinkOnClose(false)
	return ul, nil
}

// MkRuntimeDir makes the launcher's runtime directory of a pod under a
// kubelet pods directory, and returns it.
func MkRuntimeDir(podsDir, pod, runtimeDir string) (string, error) {
	dir := podsDir + "/" + pod + "/" + runtimeDir
	return dir, os.MkdirAll(dir, 0o750)
}
