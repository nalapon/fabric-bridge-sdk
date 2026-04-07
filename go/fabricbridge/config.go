package fabricbridge

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-gateway/pkg/identity"
)

// Signer signs messages
type Signer interface {
	Sign(message []byte) ([]byte, error)
}

// Identity represents a client identity
type Identity struct {
	MSPId       string
	Certificate []byte
	PrivateKey  []byte
}

// TLSOptions for TLS configuration
type TLSOptions struct {
	TrustedRoots []byte
	// Verify is kept for backward compatibility.
	// TLS server verification is enabled by default when TrustedRoots are configured.
	Verify                bool
	AllowInsecureTLS      bool
	ClientCert            []byte
	ClientKey             []byte
	SslTargetNameOverride string
}

// TimeoutConfig contains timeout settings for operations
type TimeoutConfig struct {
	Endorse   time.Duration
	Submit    time.Duration
	Commit    time.Duration
	Evaluate  time.Duration
	Discovery time.Duration
}

// DefaultTimeouts provides sensible defaults
var DefaultTimeouts = TimeoutConfig{
	Endorse:   30 * time.Second,
	Submit:    30 * time.Second,
	Commit:    60 * time.Second,
	Evaluate:  30 * time.Second,
	Discovery: 5 * time.Second,
}

// Config for the bridge connection
type Config struct {
	GatewayPeer     string
	Identity        Identity
	Signer          Signer
	TLSOptions      *TLSOptions
	Discovery       bool
	Timeouts        TimeoutConfig
	OrdererEndpoint string // Optional: orderer endpoint for commit in peer mode (e.g., "orderer.example.com:7050")
}

// Option configures a Config
type Option func(*Config)

// WithTimeout sets a custom timeout config
func WithTimeout(tc TimeoutConfig) Option {
	return func(c *Config) {
		c.Timeouts = tc
	}
}

// WithDiscovery enables or disables discovery
func WithDiscovery(enabled bool) Option {
	return func(c *Config) {
		c.Discovery = enabled
	}
}

// WithTLS sets TLS options
func WithTLS(opts TLSOptions) Option {
	return func(c *Config) {
		if len(opts.TrustedRoots) > 0 && !opts.AllowInsecureTLS {
			opts.Verify = true
		}
		c.TLSOptions = &opts
	}
}

// WithOrderer sets the orderer endpoint for commit in peer mode
func WithOrderer(endpoint string) Option {
	return func(c *Config) {
		c.OrdererEndpoint = endpoint
	}
}

// NewConfig creates a Config with functional options
func NewConfig(gatewayPeer string, identity Identity, signer Signer, opts ...Option) Config {
	c := Config{
		GatewayPeer: gatewayPeer,
		Identity:    identity,
		Signer:      signer,
		Discovery:   true,
		Timeouts:    DefaultTimeouts,
	}
	for _, opt := range opts {
		opt(&c)
	}
	return c.normalized()
}

// Validate checks if the config is valid
func (c Config) Validate() error {
	c = c.normalized()

	if c.GatewayPeer == "" {
		return fmt.Errorf("gatewayPeer is required")
	}
	if c.Identity.MSPId == "" {
		return fmt.Errorf("identity.MSPId is required")
	}
	if len(c.Identity.Certificate) == 0 {
		return fmt.Errorf("identity.Certificate is required")
	}
	if _, err := parseCertificate(c.Identity.Certificate); err != nil {
		return fmt.Errorf("identity.Certificate is invalid: %w", err)
	}
	if c.Signer == nil {
		return fmt.Errorf("signer is required")
	}
	if c.TLSOptions != nil && len(c.TLSOptions.TrustedRoots) > 0 {
		if _, err := createCertPool(c.TLSOptions.TrustedRoots); err != nil {
			return fmt.Errorf("tlsOptions.TrustedRoots is invalid: %w", err)
		}
	}
	return nil
}

// IdentityProvider creates a Fabric gateway identity from the config
func (c Config) IdentityProvider() (*identity.X509Identity, error) {
	cert, err := parseCertificate(c.Identity.Certificate)
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	return identity.NewX509Identity(c.Identity.MSPId, cert)
}

// HasPrivateKey returns true if the config has a private key (required for peer mode)
func (c Config) HasPrivateKey() bool {
	return len(c.Identity.PrivateKey) > 0
}

func (c Config) normalized() Config {
	out := c
	out.Timeouts = normalizeTimeouts(out.Timeouts)

	if out.TLSOptions != nil {
		tlsOptions := *out.TLSOptions
		if len(tlsOptions.TrustedRoots) > 0 && !tlsOptions.AllowInsecureTLS {
			tlsOptions.Verify = true
		}
		out.TLSOptions = &tlsOptions
	}

	return out
}

func normalizeTimeouts(tc TimeoutConfig) TimeoutConfig {
	if tc.Endorse == 0 {
		tc.Endorse = DefaultTimeouts.Endorse
	}
	if tc.Submit == 0 {
		tc.Submit = DefaultTimeouts.Submit
	}
	if tc.Commit == 0 {
		tc.Commit = DefaultTimeouts.Commit
	}
	if tc.Evaluate == 0 {
		tc.Evaluate = DefaultTimeouts.Evaluate
	}
	if tc.Discovery == 0 {
		tc.Discovery = DefaultTimeouts.Discovery
	}
	return tc
}

func parseCertificate(certificate []byte) (*x509.Certificate, error) {
	if len(certificate) == 0 {
		return nil, fmt.Errorf("certificate is empty")
	}

	if block, _ := pem.Decode(certificate); block != nil {
		certificate = block.Bytes
	}

	return x509.ParseCertificate(certificate)
}

func certificatePEM(certificate []byte) ([]byte, error) {
	if len(certificate) == 0 {
		return nil, fmt.Errorf("certificate is empty")
	}

	if block, _ := pem.Decode(certificate); block != nil {
		return pem.EncodeToMemory(&pem.Block{
			Type:  block.Type,
			Bytes: block.Bytes,
		}), nil
	}

	cert, err := parseCertificate(certificate)
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: cert.Raw,
	}), nil
}
