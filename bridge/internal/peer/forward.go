package peer

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/client-go/transport"
	"k8s.io/klog/v2"

	"github.com/kalik1/hangar/bridge/internal/guest"
)

// Forwarder forwards a call to the bridge pod on another node.
type Forwarder struct {
	// Port is the bridge pods' secure port.
	Port int
	// ServerName is the DNS name the peer's serving certificate is checked
	// for: every bridge pod serves the same certificate, the Service's.
	ServerName string
	// CA returns the PEM of the CA that signs the bridge's serving
	// certificate.
	CA func() []byte
	// TokenFile is the projected ServiceAccount token of audience Audience.
	// It is read on every call: the kubelet rotates it.
	TokenFile string

	mu   sync.Mutex
	rt   *http.Transport
	rtCA []byte
}

// Forward sends the call to the bridge pod at host (its pod IP), on behalf of
// caller, and copies the answer back.
func (f *Forwarder) Forward(w http.ResponseWriter, r *http.Request, host, node string, caller user.Info) {
	token, err := f.token()
	if err != nil {
		guest.WriteError(w, apierrors.NewInternalError(fmt.Errorf("reading the guest bridge's peer token: %w", err)))
		return
	}
	rt, err := f.transport()
	if err != nil {
		guest.WriteError(w, apierrors.NewInternalError(err))
		return
	}
	target := &url.URL{Scheme: "https", Host: net.JoinHostPort(host, strconv.Itoa(f.Port))}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = f.ServerName
			h := pr.Out.Header
			for name := range h {
				lower := strings.ToLower(name)
				if strings.HasPrefix(lower, "x-remote-") || strings.HasPrefix(lower, "impersonate-") {
					h.Del(name)
				}
			}
			h.Set("Authorization", "Bearer "+token)
			transport.SetAuthProxyHeaders(pr.Out, caller.GetName(), caller.GetUID(), caller.GetGroups(), caller.GetExtra())
		},
		Transport: rt,
		// The peer's answer replaces what this server set already, such as
		// its Audit-Id and Cache-Control.
		ModifyResponse: func(res *http.Response) error {
			for name := range res.Header {
				w.Header().Del(name)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				guest.WriteError(w, apierrors.NewRequestEntityTooLargeError(
					fmt.Sprintf("the body is limited to %d bytes", tooLarge.Limit)))
				return
			}
			// When the caller went away or the call timed out, nobody reads
			// the answer: no need to log it.
			if r.Context().Err() == nil {
				klog.ErrorS(err, "Forwarding a call to a peer guest bridge", "node", node, "peer", host, "path", r.URL.Path)
			}
			guest.WriteError(w, apierrors.NewServiceUnavailable(
				fmt.Sprintf("the guest bridge on node %s could not be reached: %v", node, err)))
		},
	}
	proxy.ServeHTTP(w, r)
}

func (f *Forwarder) token() (string, error) {
	b, err := os.ReadFile(f.TokenFile)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if token == "" {
		return "", errors.New("the token file is empty")
	}
	return token, nil
}

// transport returns a transport that trusts the current CA, and builds a new
// one when the CA changes.
func (f *Forwarder) transport() (*http.Transport, error) {
	ca := f.CA()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rt != nil && bytes.Equal(f.rtCA, ca) {
		return f.rt, nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("the guest bridge's CA is not loaded")
	}
	rt := &http.Transport{
		Proxy:                 nil, // pod IPs, never through a proxy
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: pool, ServerName: f.ServerName, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   5 * time.Second,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if f.rt != nil {
		f.rt.CloseIdleConnections()
	}
	f.rt, f.rtCA = rt, bytes.Clone(ca)
	return rt, nil
}
