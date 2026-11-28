// Package launcher reaches the libvirt daemon of a KubeVirt virt-launcher pod
// on this node, through the pod's libvirt-runtime emptyDir on the host.
//
// The compute container mounts the emptyDir at /var/run/libvirt, and a
// non-root launcher (KubeVirt's default) runs a session virtqemud on
// virtqemud-sock there. The launcher can write to that directory, so the
// bridge never follows a symbolic link on the way: it opens the directory
// with openat2(RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH), or one component at a
// time with O_NOFOLLOW where openat2 is missing, opens the socket itself with
// O_PATH|O_NOFOLLOW and checks that it is a socket, and dials it as
// /proc/self/fd/N. That also keeps the address short: the socket's host path
// is about 120 bytes, over the 108 of a unix socket address.
package launcher

import (
	"errors"
	"fmt"
	"net"
	"path"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
	"k8s.io/apimachinery/pkg/types"
)

const (
	// DefaultPodsDir is the kubelet's pods directory. The bridge mounts it
	// from the host, read-only, at the same path.
	DefaultPodsDir = "/var/lib/kubelet/pods"
	// RuntimeDir is the launcher's libvirt-runtime emptyDir, under the
	// pod's directory.
	RuntimeDir = "volumes/kubernetes.io~empty-dir/libvirt-runtime"
	// SocketName is the session virtqemud's socket in RuntimeDir.
	SocketName = "virtqemud-sock"
	// DialTimeout bounds the connect.
	DialTimeout = 5 * time.Second
)

var (
	// ErrNoSocket is a launcher pod without its libvirt socket on this
	// node: it is starting or stopping, or it runs elsewhere.
	ErrNoSocket = errors.New("the launcher's libvirt socket is not there")
	// ErrUnsafePath is a symbolic link, or something that is not a
	// directory or not a socket, on the way to the socket. The bridge
	// refuses it.
	ErrUnsafePath = errors.New("refusing an unsafe path to the launcher's libvirt socket")
)

// Dialer dials the virtqemud of launcher pods under a kubelet pods
// directory.
type Dialer struct {
	// PodsDir is the kubelet's pods directory, as the bridge sees it. Empty
	// is DefaultPodsDir.
	PodsDir string

	// noOpenat2 walks the path one component at a time, as on a kernel
	// without openat2 (tests).
	noOpenat2 bool
}

// Dial connects to the virtqemud of the launcher pod with the given UID.
// Its errors wrap ErrNoSocket or ErrUnsafePath where they are those.
func (d *Dialer) Dial(pod types.UID) (net.Conn, error) {
	if err := validPodUID(pod); err != nil {
		return nil, err
	}
	rel := path.Join(string(pod), RuntimeDir)
	dir, err := d.openDir(rel)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)

	sock, err := unix.Openat(dir, SocketName, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, pathError(path.Join(rel, SocketName), err)
	}
	defer unix.Close(sock)
	var st unix.Stat_t
	if err := unix.Fstat(sock, &st); err != nil {
		return nil, fmt.Errorf("stat %s: %w", path.Join(rel, SocketName), err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFSOCK {
		what := "not a socket"
		if st.Mode&unix.S_IFMT == unix.S_IFLNK {
			what = "a symbolic link"
		}
		return nil, fmt.Errorf("%w: %s is %s", ErrUnsafePath, path.Join(rel, SocketName), what)
	}

	// The magic link /proc/self/fd/N is the socket's inode itself: connect
	// follows nothing the launcher can change.
	conn, err := net.DialTimeout("unix", "/proc/self/fd/"+strconv.Itoa(sock), DialTimeout)
	if err != nil {
		if errors.Is(err, unix.ECONNREFUSED) {
			return nil, fmt.Errorf("%w: nothing listens on %s", ErrNoSocket, path.Join(rel, SocketName))
		}
		return nil, fmt.Errorf("connecting to %s: %w", path.Join(rel, SocketName), err)
	}
	return conn, nil
}

func (d *Dialer) podsDir() string {
	if d.PodsDir == "" {
		return DefaultPodsDir
	}
	return d.PodsDir
}

// openDir opens rel under the pods directory as an O_PATH directory,
// following no symbolic link.
func (d *Dialer) openDir(rel string) (int, error) {
	root, err := unix.Open(d.podsDir(), unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("opening the kubelet's pods directory %s: %w", d.podsDir(), err)
	}
	defer unix.Close(root)

	if !d.noOpenat2 {
		fd, err := unix.Openat2(root, rel, &unix.OpenHow{
			Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
			Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_BENEATH,
		})
		if err == nil {
			return fd, nil
		}
		// Older kernels have no openat2, and some seccomp profiles refuse
		// it: walk instead.
		if !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EPERM) {
			return -1, pathError(rel, err)
		}
	}

	cur, err := unix.Dup(root)
	if err != nil {
		return -1, err
	}
	for _, name := range strings.Split(rel, "/") {
		if name == "" || name == "." || name == ".." {
			unix.Close(cur)
			return -1, fmt.Errorf("%w: %q", ErrUnsafePath, rel)
		}
		// O_DIRECTORY with O_NOFOLLOW fails on a symbolic link (ENOTDIR).
		next, err := unix.Openat(cur, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		unix.Close(cur)
		if err != nil {
			return -1, pathError(rel, err)
		}
		cur = next
	}
	return cur, nil
}

func pathError(rel string, err error) error {
	switch {
	case errors.Is(err, unix.ENOENT):
		return fmt.Errorf("%w: %s: %v", ErrNoSocket, rel, err)
	case errors.Is(err, unix.ELOOP), errors.Is(err, unix.ENOTDIR), errors.Is(err, unix.EXDEV):
		// ELOOP: a symbolic link under RESOLVE_NO_SYMLINKS or O_NOFOLLOW;
		// ENOTDIR: a link or a file where a directory should be; EXDEV:
		// a path out of the pods directory under RESOLVE_BENEATH.
		return fmt.Errorf("%w: %s: %v", ErrUnsafePath, rel, err)
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
		return fmt.Errorf("opening %s: %w (the bridge needs root with CAP_DAC_OVERRIDE, and SELinux type spc_t)", rel, err)
	}
	return fmt.Errorf("opening %s: %w", rel, err)
}

// validPodUID refuses a pod UID that is not one: it is a path component.
func validPodUID(pod types.UID) error {
	s := string(pod)
	if s == "" || len(s) > 128 {
		return fmt.Errorf("%w: a pod UID of %d bytes", ErrUnsafePath, len(s))
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return fmt.Errorf("%w: pod UID %q", ErrUnsafePath, s)
		}
	}
	return nil
}
