package fabricbridge

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-gateway/pkg/identity"
)

// Signer signs message digests.
type Signer interface {
	Sign(digest []byte) ([]byte, error)
}

// Identity represents a client identity
type Identity struct {
	MSPId       string
	Certificate []byte
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
	GatewayEndpoint string
	DiscoverySeed   string
	OrdererEndpoint string
	Identity        Identity
	Signer          Signer
	GatewayTLS      *TLSOptions
	DiscoveryTLS    *TLSOptions
	OrdererTLS      *TLSOptions
	Discovery       bool
	Timeouts        TimeoutConfig
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

// WithDiscoverySeed sets the initial peer endpoint used for Fabric service discovery.
func WithDiscoverySeed(endpoint string) Option {
	return func(c *Config) {
		c.DiscoverySeed = endpoint
	}
}

// WithGatewayTLS sets TLS options for the Gateway endpoint.
func WithGatewayTLS(opts TLSOptions) Option {
	return func(c *Config) {
		c.GatewayTLS = normalizedTLSOptions(opts)
	}
}

// WithDiscoveryTLS sets TLS options for the Discovery seed.
func WithDiscoveryTLS(opts TLSOptions) Option {
	return func(c *Config) {
		c.DiscoveryTLS = normalizedTLSOptions(opts)
	}
}

// WithOrdererTLS sets dedicated TLS options for the orderer used by direct endorsement submit.
func WithOrdererTLS(opts TLSOptions) Option {
	return func(c *Config) {
		c.OrdererTLS = normalizedTLSOptions(opts)
	}
}

// WithOrderer sets the orderer endpoint for direct endorsement submit.
func WithOrderer(endpoint string) Option {
	return func(c *Config) {
		c.OrdererEndpoint = endpoint
	}
}

// NewConfig creates a Config with functional options
func NewConfig(gatewayEndpoint string, identity Identity, signer Signer, opts ...Option) Config {
	c := Config{
		GatewayEndpoint: gatewayEndpoint,
		Identity:        identity,
		Signer:          signer,
		Discovery:       true,
		Timeouts:        DefaultTimeouts,
	}
	for _, opt := range opts {
		opt(&c)
	}
	return c.normalized()
}

// Validate checks if the config is valid
func (c Config) Validate() error {
	c = c.normalized()

	if c.GatewayEndpoint == "" {
		return fmt.Errorf("gatewayEndpoint is required")
	}
	if c.DiscoverySeed == "" {
		return fmt.Errorf("discoverySeed is required")
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
	if c.GatewayTLS != nil && len(c.GatewayTLS.TrustedRoots) > 0 {
		if _, err := createCertPool(c.GatewayTLS.TrustedRoots); err != nil {
			return fmt.Errorf("gatewayTls.TrustedRoots is invalid: %w", err)
		}
	}
	if c.DiscoveryTLS != nil && len(c.DiscoveryTLS.TrustedRoots) > 0 {
		if _, err := createCertPool(c.DiscoveryTLS.TrustedRoots); err != nil {
			return fmt.Errorf("discoveryTls.TrustedRoots is invalid: %w", err)
		}
	}
	if c.OrdererTLS != nil && len(c.OrdererTLS.TrustedRoots) > 0 {
		if _, err := createCertPool(c.OrdererTLS.TrustedRoots); err != nil {
			return fmt.Errorf("ordererTls.TrustedRoots is invalid: %w", err)
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

func (c Config) normalized() Config {
	out := c
	out.Timeouts = normalizeTimeouts(out.Timeouts)

	if out.DiscoverySeed == "" {
		out.DiscoverySeed = out.GatewayEndpoint
	}

	out.GatewayTLS = cloneTLSOptions(out.GatewayTLS)
	if out.DiscoveryTLS == nil {
		out.DiscoveryTLS = cloneTLSOptions(out.GatewayTLS)
	} else {
		out.DiscoveryTLS = cloneTLSOptions(out.DiscoveryTLS)
	}
	if out.OrdererTLS == nil {
		out.OrdererTLS = cloneTLSOptions(out.GatewayTLS)
	} else {
		out.OrdererTLS = cloneTLSOptions(out.OrdererTLS)
	}

	return out
}

func normalizedTLSOptions(opts TLSOptions) *TLSOptions {
	if len(opts.TrustedRoots) > 0 && !opts.AllowInsecureTLS {
		opts.Verify = true
	}
	return &opts
}

func cloneTLSOptions(opts *TLSOptions) *TLSOptions {
	if opts == nil {
		return nil
	}
	clone := *normalizedTLSOptions(*opts)
	return &clone
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
