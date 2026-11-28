package agent

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
)

// maxPacket bounds one packet from a launcher's libvirt. libvirt caps an
// RPC string at 4 MiB (VIR_NET_MESSAGE_STRING_MAX), and with it an agent
// reply; the margin is the packet's header and the rest of the reply. go-libvirt
// allocates whatever length a packet claims, so a larger one, which libvirt
// never sends, closes the connection before it is read.
const maxPacket = 4<<20 + 64<<10

// minPacket is a packet's length prefix and header.
const minPacket = 28

var errBadPacket = errors.New("a packet from libvirt of an impossible length")

// limitConn passes a libvirt RPC stream through unchanged, and fails the
// read that brings a packet length outside [minPacket, maxPacket].
type limitConn struct {
	net.Conn
	// need is what is left of the current packet; 0 means the next bytes
	// are a length prefix, of which hdr holds hdrLen bytes.
	need   int
	hdr    [4]byte
	hdrLen int
}

func (c *limitConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if ferr := c.observe(p[:n]); ferr != nil {
		_ = c.Conn.Close()
		return 0, ferr
	}
	return n, err
}

func (c *limitConn) observe(b []byte) error {
	for len(b) > 0 {
		if c.need == 0 {
			k := copy(c.hdr[c.hdrLen:], b)
			c.hdrLen += k
			b = b[k:]
			if c.hdrLen < len(c.hdr) {
				return nil
			}
			c.hdrLen = 0
			size := binary.BigEndian.Uint32(c.hdr[:])
			if size < minPacket || size > maxPacket {
				return fmt.Errorf("%w: %d bytes", errBadPacket, size)
			}
			c.need = int(size) - len(c.hdr)
			continue
		}
		k := min(c.need, len(b))
		c.need -= k
		b = b[k:]
	}
	return nil
}
