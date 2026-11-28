package agent

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
)

func packet(payload int) []byte {
	b := make([]byte, 28+payload)
	binary.BigEndian.PutUint32(b, uint32(28+payload))
	for i := 4; i < len(b); i++ {
		b[i] = byte(i)
	}
	return b
}

// TestLimitConn: the stream passes unchanged, read in any pieces, and a
// packet whose length libvirt never sends closes the connection.
func TestLimitConn(t *testing.T) {
	var small, large []byte
	for _, n := range []int{0, 4, 100, 3} {
		small = append(small, packet(n)...)
	}
	for _, n := range []int{1 << 20, 3, maxPacket - 28} {
		large = append(large, packet(n)...)
	}
	for _, tc := range []struct {
		stream []byte
		piece  int
	}{{small, 1}, {small, 3}, {small, 7}, {large, 4093}, {large, 1 << 20}} {
		stream, piece := tc.stream, tc.piece
		server, client := net.Pipe()
		go func() {
			for b := stream; len(b) > 0; {
				n := min(piece, len(b))
				if _, err := server.Write(b[:n]); err != nil {
					return
				}
				b = b[n:]
			}
			server.Close()
		}()
		got, err := io.ReadAll(&limitConn{Conn: client})
		if err != nil || !bytes.Equal(got, stream) {
			t.Errorf("pieces of %d: %d bytes, %v", piece, len(got), err)
		}
	}

	for _, size := range []uint32{maxPacket + 1, 1 << 31, 27, 0} {
		server, client := net.Pipe()
		go func() {
			b := packet(4)
			binary.BigEndian.PutUint32(b, size)
			_, _ = server.Write(append(packet(8), b...))
			server.Close()
		}()
		lc := &limitConn{Conn: client}
		if _, err := io.ReadAll(lc); !errors.Is(err, errBadPacket) {
			t.Errorf("length %d: %v, want errBadPacket", size, err)
		}
	}
}
