// Package certs manages the guest bridge's own certificates.
//
// The bridge needs no cert-manager. The first pod creates a CA (10 years)
// and a serving certificate for the Service (1 year) in one Secret; a create
// that conflicts means another pod did it. The pod that holds the Lease
// renews the serving certificate 30 days before it expires, repairs a Secret
// that is not usable, and keeps the APIService's caBundle on the CA. Every
// pod serves the Secret's certificate, and reloads it when it changes.
package certs

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// The keys of the Secret.
const (
	KeyCACert = "ca.crt"
	KeyCAKey  = "ca.key"
	KeyCert   = corev1.TLSCertKey
	KeyKey    = corev1.TLSPrivateKeyKey
)

// Validity and renewal.
const (
	CAValidity      = 10 * 365 * 24 * time.Hour
	ServingValidity = 365 * 24 * time.Hour
	// RenewBefore is how long before its end a serving certificate is
	// renewed. A CA this close to its end is replaced, with a new serving
	// certificate.
	RenewBefore = 30 * 24 * time.Hour
	// backdate covers clocks that lag behind the creator's.
	backdate = time.Hour
)

// Bundle is the content of the Secret: a CA and the serving certificate it
// signed, in PEM.
type Bundle struct {
	CACert []byte
	CAKey  []byte
	Cert   []byte
	Key    []byte

	ca    *x509.Certificate
	caKey crypto.Signer
	leaf  *x509.Certificate
}

// State is what a Bundle needs.
type State int

const (
	// Fresh: usable, nothing to do.
	Fresh State = iota
	// Renew: the CA is good, the serving certificate needs a new one.
	Renew
	// Replace: the bundle is not usable, or its CA ends soon. A new CA and
	// serving certificate replace it.
	Replace
)

func (s State) String() string {
	switch s {
	case Fresh:
		return "fresh"
	case Renew:
		return "renew"
	default:
		return "replace"
	}
}

// Generate returns a new CA and a serving certificate for dnsNames.
func Generate(now time.Time, dnsNames []string) (*Bundle, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := serialNumber()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: fmt.Sprintf("hangar-guest-bridge-ca@%d", now.Unix())},
		NotBefore:             now.Add(-backdate),
		NotAfter:              now.Add(CAValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		return nil, err
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	keyPEM, err := encodeKey(key)
	if err != nil {
		return nil, err
	}
	b := &Bundle{
		CACert: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		CAKey:  keyPEM,
		ca:     ca,
		caKey:  key,
	}
	return b.Renewed(now, dnsNames)
}

// Renewed returns a copy of b with a new serving certificate for dnsNames,
// signed by b's CA. It never outlives the CA.
func (b *Bundle) Renewed(now time.Time, dnsNames []string) (*Bundle, error) {
	if b.ca == nil || b.caKey == nil {
		return nil, errors.New("the bundle has no CA")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := serialNumber()
	if err != nil {
		return nil, err
	}
	notAfter := now.Add(ServingValidity)
	if notAfter.After(b.ca.NotAfter) {
		notAfter = b.ca.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: dnsNames[0]},
		DNSNames:     slices.Clone(dnsNames),
		NotBefore:    now.Add(-backdate),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, b.ca, key.Public(), b.caKey)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	keyPEM, err := encodeKey(key)
	if err != nil {
		return nil, err
	}
	return &Bundle{
		CACert: b.CACert,
		CAKey:  b.CAKey,
		Cert:   pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		Key:    keyPEM,
		ca:     b.ca,
		caKey:  b.caKey,
		leaf:   leaf,
	}, nil
}

// Parse reads a bundle from a Secret's data. It checks that each part
// parses and that each key belongs to its certificate.
func Parse(data map[string][]byte) (*Bundle, error) {
	b := &Bundle{CACert: data[KeyCACert], CAKey: data[KeyCAKey], Cert: data[KeyCert], Key: data[KeyKey]}
	for key, v := range map[string][]byte{KeyCACert: b.CACert, KeyCAKey: b.CAKey, KeyCert: b.Cert, KeyKey: b.Key} {
		if len(v) == 0 {
			return nil, fmt.Errorf("%s is missing", key)
		}
	}
	caPair, err := tls.X509KeyPair(b.CACert, b.CAKey)
	if err != nil {
		return nil, fmt.Errorf("the CA: %w", err)
	}
	b.ca = caPair.Leaf
	signer, ok := caPair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("the CA key cannot sign")
	}
	b.caKey = signer
	pair, err := tls.X509KeyPair(b.Cert, b.Key)
	if err != nil {
		return nil, fmt.Errorf("the serving certificate: %w", err)
	}
	b.leaf = pair.Leaf
	return b, nil
}

// Data returns the bundle as a Secret's data.
func (b *Bundle) Data() map[string][]byte {
	return map[string][]byte{KeyCACert: b.CACert, KeyCAKey: b.CAKey, KeyCert: b.Cert, KeyKey: b.Key}
}

// NotAfter returns the end of the serving certificate.
func (b *Bundle) NotAfter() time.Time { return b.leaf.NotAfter }

// Check returns what the bundle needs at now, to serve dnsName, with the
// reason when it is not Fresh.
func (b *Bundle) Check(now time.Time, dnsName string) (State, string) {
	switch {
	case !b.ca.IsCA:
		return Replace, "the CA certificate is not a CA"
	case !now.Before(b.ca.NotAfter.Add(-RenewBefore)):
		return Replace, fmt.Sprintf("the CA ends on %s", b.ca.NotAfter.UTC().Format(time.RFC3339))
	}
	roots := x509.NewCertPool()
	roots.AddCert(b.ca)
	// The chain and the name, whatever the time: an expired serving
	// certificate is renewed, not replaced.
	if _, err := b.leaf.Verify(x509.VerifyOptions{
		Roots:       roots,
		DNSName:     dnsName,
		CurrentTime: b.leaf.NotBefore.Add(time.Second),
		KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		return Replace, fmt.Sprintf("the serving certificate does not fit the CA and the Service: %v", err)
	}
	if !now.Before(b.leaf.NotAfter.Add(-RenewBefore)) {
		return Renew, fmt.Sprintf("the serving certificate ends on %s", b.leaf.NotAfter.UTC().Format(time.RFC3339))
	}
	return Fresh, ""
}

func encodeKey(key crypto.Signer) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func serialNumber() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}
