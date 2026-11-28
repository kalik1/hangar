// Command hangar-guest-bridge is Hangar's guest bridge: an aggregated API,
// served by a DaemonSet, that gives each VM's guest agent to the users RBAC
// allows, as subresources of KubeVirt's virtualmachineinstances in the group
// subresources.hangar.magesgate.com.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	genericapiserver "k8s.io/apiserver/pkg/server"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/klog/v2"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
	"github.com/kalik1/hangar/bridge/internal/app"
	"github.com/kalik1/hangar/bridge/internal/guest"
	"github.com/kalik1/hangar/bridge/internal/guestfiles"
	"github.com/kalik1/hangar/bridge/internal/guestinfo"
	"github.com/kalik1/hangar/bridge/internal/launcher"
)

// version is set at build time: -ldflags "-X main.version=v0.2.0".
var version = "dev"

func main() {
	klog.InitFlags(nil)
	var (
		kubeconfig    = flag.String("kubeconfig", "", "kubeconfig file; empty means the pod's ServiceAccount")
		bindAddress   = flag.String("bind-address", "", "address to listen on; empty means all")
		securePort    = flag.Int("secure-port", app.DefaultSecurePort, "HTTPS port, also the port bridge pods forward calls to")
		namespace     = flag.String("namespace", envOr("POD_NAMESPACE", app.DefaultNamespace), "the bridge's namespace")
		nodeName      = flag.String("node-name", os.Getenv("NODE_NAME"), "this pod's node")
		podName       = flag.String("pod-name", os.Getenv("POD_NAME"), "this pod's name")
		peerTokenFile = flag.String("peer-token-file", app.DefaultPeerTokenFile, "projected ServiceAccount token of audience hangar-guest-bridge")
		shutdownDelay = flag.Duration("shutdown-delay", 5*time.Second, "time to keep serving after SIGTERM, while /readyz fails")
		podsDir       = flag.String("kubelet-pods-dir", launcher.DefaultPodsDir, "the kubelet's pods directory, mounted from the host read-only")
		showVersion   = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	cfg, err := clientcmd.BuildConfigFromFlags("", *kubeconfig)
	if err != nil {
		klog.ErrorS(err, "Reading the API server configuration")
		os.Exit(1)
	}
	cfg = rest.AddUserAgent(cfg, "hangar-guest-bridge/"+version)
	// Each call reads its VMI: a 100 MB transfer in 1 MiB calls must not
	// wait for the client's rate limiter.
	cfg.QPS, cfg.Burst = 50, 100

	klog.InfoS("Starting the guest bridge", "version", version, "node", *nodeName, "pod", *podName)
	ctx := genericapiserver.SetupSignalContext()
	if err := app.Run(ctx, app.Options{
		RESTConfig:    cfg,
		BindAddress:   *bindAddress,
		SecurePort:    *securePort,
		Namespace:     *namespace,
		NodeName:      *nodeName,
		PodName:       *podName,
		PeerTokenFile: *peerTokenFile,
		ShutdownDelay: *shutdownDelay,
		Handlers:      handlers(*podsDir),
	}); err != nil {
		klog.ErrorS(err, "The guest bridge stopped")
		klog.FlushAndExit(klog.ExitFlushTimeout, 1)
	}
	klog.Flush()
}

// handlers serves guestinfo and guestfiles through one libvirt connection
// per launcher pod on this node. guestfiles records its changes as Events
// on the VMIs.
func handlers(podsDir string) app.HandlersFunc {
	return func(ctx context.Context, env app.Env) (map[string]guest.Handler, error) {
		dialer := &launcher.Dialer{PodsDir: podsDir}
		pool := agent.NewPool(agent.PoolConfig{Dial: dialer.Dial})
		files := &guestfiles.Handler{
			VMs:    pool,
			Events: &guestfiles.KubeRecorder{Events: env.Kube.CoreV1(), Node: env.NodeName},
		}
		go func() {
			<-ctx.Done()
			files.Close()
			pool.Close()
		}()
		return map[string]guest.Handler{
			v1alpha1.SubresourceGuestInfo:  &guestinfo.Handler{VMs: pool},
			v1alpha1.SubresourceGuestFiles: files,
		}, nil
	}
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
