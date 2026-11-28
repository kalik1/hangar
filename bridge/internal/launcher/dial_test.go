package launcher

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"

	"k8s.io/apimachinery/pkg/types"

	"github.com/kalik1/hangar/bridge/internal/fakelibvirt"
)

const podUID = "3f1c2a7e-8b5d-4c1e-9a0f-1b2c3d4e5f60"

// serve listens on dir/virtqemud-sock and greets each connection.
func serve(t *testing.T, dir string) *net.UnixListener {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	ln, err := fakelibvirt.ListenUnix(dir, SocketName)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("hello"))
			c.Close()
		}
	}()
	return ln
}

func dialers(pods string) map[string]*Dialer {
	return map[string]*Dialer{
		"openat2":       {PodsDir: pods},
		"per component": {PodsDir: pods, noOpenat2: true},
	}
}

// TestDial reaches a socket whose path is longer than a unix socket
// address allows, with openat2 and with the per-component walk.
func TestDial(t *testing.T) {
	pods := t.TempDir()
	runtime := filepath.Join(pods, podUID, RuntimeDir)
	serve(t, runtime)
	if n := len(filepath.Join(runtime, SocketName)); n <= 108 {
		t.Fatalf("the test socket's path is %d bytes: it must not fit in a socket address", n)
	}
	for name, d := range dialers(pods) {
		c, err := d.Dial(podUID)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		b, _ := io.ReadAll(c)
		c.Close()
		if string(b) != "hello" {
			t.Errorf("%s: read %q", name, b)
		}
	}
}

// TestDialRefusesSymlinks: the launcher can write to its runtime
// directory, and a link anywhere on the way would let it point the bridge
// elsewhere.
func TestDialRefusesSymlinks(t *testing.T) {
	cases := map[string]func(t *testing.T, pods, elsewhere string){
		"the runtime directory is a link": func(t *testing.T, pods, elsewhere string) {
			parent := filepath.Join(pods, podUID, filepath.Dir(RuntimeDir))
			mustMkdir(t, parent)
			mustSymlink(t, elsewhere, filepath.Join(parent, filepath.Base(RuntimeDir)))
		},
		"a directory on the way is a link": func(t *testing.T, pods, elsewhere string) {
			// elsewhere/kubernetes.io~empty-dir/libvirt-runtime/virtqemud-sock
			// is served, and volumes points at elsewhere.
			mustMkdir(t, filepath.Join(pods, podUID))
			mustSymlink(t, elsewhere, filepath.Join(pods, podUID, "volumes"))
		},
		"the pod directory is a link": func(t *testing.T, pods, elsewhere string) {
			mustSymlink(t, elsewhere, filepath.Join(pods, podUID))
		},
		"a relative link to another pod's runtime directory": func(t *testing.T, pods, _ string) {
			// Inside the pods directory: RESOLVE_BENEATH alone lets it pass.
			other := filepath.Join(pods, "other-pod", RuntimeDir)
			serve(t, other)
			parent := filepath.Join(pods, podUID, filepath.Dir(RuntimeDir))
			mustMkdir(t, parent)
			rel, err := filepath.Rel(parent, other)
			if err != nil {
				t.Fatal(err)
			}
			mustSymlink(t, rel, filepath.Join(parent, filepath.Base(RuntimeDir)))
		},
		"the socket is a link": func(t *testing.T, pods, elsewhere string) {
			runtime := filepath.Join(pods, podUID, RuntimeDir)
			mustMkdir(t, runtime)
			mustSymlink(t, filepath.Join(elsewhere, SocketName), filepath.Join(runtime, SocketName))
		},
		"the socket is a file": func(t *testing.T, pods, _ string) {
			runtime := filepath.Join(pods, podUID, RuntimeDir)
			mustMkdir(t, runtime)
			if err := os.WriteFile(filepath.Join(runtime, SocketName), nil, 0o600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			pods := filepath.Join(root, "pods")
			elsewhere := filepath.Join(root, "elsewhere")
			mustMkdir(t, pods)
			// A live socket at every place a link may point to.
			serve(t, elsewhere)
			serve(t, filepath.Join(elsewhere, "kubernetes.io~empty-dir", "libvirt-runtime"))
			serve(t, filepath.Join(elsewhere, RuntimeDir))
			setup(t, pods, elsewhere)
			for how, d := range dialers(pods) {
				c, err := d.Dial(podUID)
				if err == nil {
					c.Close()
					t.Errorf("%s: dialled through a link", how)
					continue
				}
				if !errors.Is(err, ErrUnsafePath) {
					t.Errorf("%s: %v, want ErrUnsafePath", how, err)
				}
			}
		})
	}
}

func TestDialNoSocket(t *testing.T) {
	pods := t.TempDir()
	// A pod without its runtime directory, and one whose virtqemud is gone
	// (its socket file stays).
	mustMkdir(t, filepath.Join(pods, "starting"))
	ln := serve(t, filepath.Join(pods, "stopped", RuntimeDir))
	ln.Close()
	for _, pod := range []types.UID{"missing", "starting", "stopped"} {
		for how, d := range dialers(pods) {
			if _, err := d.Dial(pod); !errors.Is(err, ErrNoSocket) {
				t.Errorf("%s, %s: %v, want ErrNoSocket", pod, how, err)
			}
		}
	}
}

func TestDialBadPodUID(t *testing.T) {
	d := &Dialer{PodsDir: t.TempDir()}
	for _, pod := range []types.UID{"", ".", "..", "../x", "a/b", "/abs", "a b", types.UID(make([]byte, 129))} {
		if _, err := d.Dial(pod); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("%q: %v, want ErrUnsafePath", pod, err)
		}
	}
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
}

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}
