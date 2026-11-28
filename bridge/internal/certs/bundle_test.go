package certs

import (
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

var (
	testNames = []string{"hangar-guest-bridge.hangar-system.svc", "hangar-guest-bridge"}
	t0        = time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
)

func mustGenerate(t *testing.T, now time.Time) *Bundle {
	t.Helper()
	b, err := Generate(now, testNames)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func parseCert(t *testing.T, p []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(p)
	if block == nil {
		t.Fatal("no PEM")
	}
	c, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestGenerate(t *testing.T) {
	b := mustGenerate(t, t0)
	ca, leaf := parseCert(t, b.CACert), parseCert(t, b.Cert)
	if !ca.IsCA || ca.NotAfter.Sub(t0) != CAValidity {
		t.Errorf("CA: IsCA %v, validity %v", ca.IsCA, ca.NotAfter.Sub(t0))
	}
	if got := leaf.NotAfter.Sub(t0); got != ServingValidity {
		t.Errorf("serving validity %v, want %v", got, ServingValidity)
	}
	if leaf.IsCA || strings.Join(leaf.DNSNames, ",") != strings.Join(testNames, ",") {
		t.Errorf("serving certificate: IsCA %v, names %v", leaf.IsCA, leaf.DNSNames)
	}
	if err := leaf.CheckSignatureFrom(ca); err != nil {
		t.Errorf("serving certificate not signed by the CA: %v", err)
	}
	if st, why := b.Check(t0, testNames[0]); st != Fresh {
		t.Errorf("Check = %v (%s), want fresh", st, why)
	}
}

func TestParseRoundTrip(t *testing.T) {
	b := mustGenerate(t, t0)
	p, err := Parse(b.Data())
	if err != nil {
		t.Fatal(err)
	}
	if st, why := p.Check(t0, testNames[0]); st != Fresh {
		t.Errorf("Check = %v (%s)", st, why)
	}
}

func TestParseRefusesBrokenData(t *testing.T) {
	b := mustGenerate(t, t0)
	other := mustGenerate(t, t0)
	cases := map[string]func(map[string][]byte){
		"missing tls.key":         func(d map[string][]byte) { delete(d, KeyKey) },
		"missing ca.crt":          func(d map[string][]byte) { delete(d, KeyCACert) },
		"garbage certificate":     func(d map[string][]byte) { d[KeyCert] = []byte("not a certificate") },
		"key of another cert":     func(d map[string][]byte) { d[KeyKey] = other.Key },
		"CA key of another CA":    func(d map[string][]byte) { d[KeyCAKey] = other.CAKey },
		"empty CA key":            func(d map[string][]byte) { d[KeyCAKey] = nil },
		"serving cert in CA slot": func(d map[string][]byte) { d[KeyCACert], d[KeyCAKey] = b.Cert, b.Key },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			d := b.Data()
			mutate(d)
			p, err := Parse(d)
			if err == nil {
				// It parses: Check must then refuse it.
				if st, _ := p.Check(t0, testNames[0]); st != Replace {
					t.Fatalf("parsed and %v, want an error or replace", st)
				}
			}
		})
	}
}

func TestCheck(t *testing.T) {
	b := mustGenerate(t, t0)
	other := mustGenerate(t, t0)
	foreign := &Bundle{CACert: b.CACert, CAKey: b.CAKey, Cert: other.Cert, Key: other.Key, ca: b.ca, caKey: b.caKey, leaf: other.leaf}
	cases := []struct {
		name   string
		bundle *Bundle
		now    time.Time
		dns    string
		want   State
	}{
		{"fresh", b, t0, testNames[0], Fresh},
		{"31 days before the end", b, t0.Add(ServingValidity - 31*24*time.Hour), testNames[0], Fresh},
		{"29 days before the end", b, t0.Add(ServingValidity - 29*24*time.Hour), testNames[0], Renew},
		{"expired serving certificate", b, t0.Add(ServingValidity + time.Hour), testNames[0], Renew},
		{"CA ends within 30 days", b, t0.Add(CAValidity - 29*24*time.Hour), testNames[0], Replace},
		{"other Service name", b, t0, "other.hangar-system.svc", Replace},
		{"serving certificate of another CA", foreign, t0, testNames[0], Replace},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, why := tc.bundle.Check(tc.now, tc.dns); got != tc.want {
				t.Errorf("Check = %v (%s), want %v", got, why, tc.want)
			}
		})
	}
}

func TestRenewedKeepsTheCA(t *testing.T) {
	b := mustGenerate(t, t0)
	later := t0.Add(ServingValidity - 10*24*time.Hour)
	r, err := b.Renewed(later, testNames)
	if err != nil {
		t.Fatal(err)
	}
	if string(r.CACert) != string(b.CACert) || string(r.CAKey) != string(b.CAKey) {
		t.Error("renewal changed the CA")
	}
	if string(r.Cert) == string(b.Cert) || string(r.Key) == string(b.Key) {
		t.Error("renewal kept the serving certificate or key")
	}
	if got := parseCert(t, r.Cert).NotAfter; !got.Equal(later.Add(ServingValidity)) {
		t.Errorf("renewed NotAfter %v", got)
	}
	if st, why := r.Check(later, testNames[0]); st != Fresh {
		t.Errorf("Check = %v (%s)", st, why)
	}
}

func TestRenewedNeverOutlivesTheCA(t *testing.T) {
	b := mustGenerate(t, t0)
	late := t0.Add(CAValidity - 100*24*time.Hour)
	r, err := b.Renewed(late, testNames)
	if err != nil {
		t.Fatal(err)
	}
	if !parseCert(t, r.Cert).NotAfter.Equal(b.ca.NotAfter) {
		t.Errorf("serving certificate ends after its CA")
	}
}
