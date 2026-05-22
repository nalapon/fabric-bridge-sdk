package fabricbridge

import (
	"strings"
	"testing"
)

type testSigner struct{}

func (testSigner) Sign(digest []byte) ([]byte, error) {
	return append([]byte(nil), digest...), nil
}

var testIdentity = Identity{
	MSPId:       "Org1MSP",
	Certificate: []byte(testCertificatePEM),
}

const testCertificatePEM = `-----BEGIN CERTIFICATE-----
MIIBWjCB3qADAgECAgYBbvXSw4QwDQYJKoZIhvcNAQELBQAwEzERMA8GA1UEAwwI
Sm9obiBEb2UwHhcNMTkxMjEwMTYzNzQwWhcNMTkxMTI2MDA1NTUxWjATMREwDwYD
VQQDDAhKb2huIERvZTB2MBAGByqGSM49AgEGBSuBBAAiA2IABBIV2OGF/VkRcQTf
5NjLpQMIW+kc6VmBdpd7+YJ4CrpxtCISiMcDf4LxQ2QdVhkM0FSiYCFLxnDOg8u6
Tm+uKVzlH0HEKkPycoDk784dcvyXiUuWuo6ZHXaCQJfEHNldPzANBgkqhkiG9w0B
AQsFAANoADBlAjEAoNys0S+/R9/w3bUMwohRN7NuIh2JYmxy3oEafunF4LaNaRd8
dG9gLBn/7LQZGUu7AjBLQQMV0GPZCNl6JN4TZyxcARxDCmpiuIAzwZuFRYpaAVTO
pJgR6ICTZ0Ko3rz4cT4=
-----END CERTIFICATE-----`

func TestConfigDefaultsDiscoverySeedAndTLSRoles(t *testing.T) {
	cfg := NewConfig(
		"gateway.example.com:7051",
		testIdentity,
		testSigner{},
		WithGatewayTLS(TLSOptions{
			TrustedRoots:          []byte(testCertificatePEM),
			SslTargetNameOverride: "gateway.example.com",
		}),
	)

	if cfg.GatewayEndpoint != "gateway.example.com:7051" {
		t.Fatalf("gateway endpoint mismatch: %q", cfg.GatewayEndpoint)
	}
	if cfg.DiscoverySeed != cfg.GatewayEndpoint {
		t.Fatalf("expected discovery seed to default to gateway endpoint, got %q", cfg.DiscoverySeed)
	}
	if cfg.GatewayTLS == nil || cfg.DiscoveryTLS == nil || cfg.OrdererTLS == nil {
		t.Fatal("expected gateway TLS to default discovery and orderer TLS")
	}
	if cfg.GatewayTLS == cfg.DiscoveryTLS || cfg.GatewayTLS == cfg.OrdererTLS {
		t.Fatal("expected TLS role defaults to be cloned, not pointer aliases")
	}
	if !cfg.GatewayTLS.Verify || !cfg.DiscoveryTLS.Verify || !cfg.OrdererTLS.Verify {
		t.Fatal("expected trusted roots to enable TLS verification for all defaulted roles")
	}
	if cfg.DiscoveryTLS.SslTargetNameOverride != "gateway.example.com" {
		t.Fatalf("discovery TLS override mismatch: %q", cfg.DiscoveryTLS.SslTargetNameOverride)
	}
}

func TestConfigAllowsDiscoveryAndOrdererRoleOverrides(t *testing.T) {
	cfg := NewConfig(
		"gateway.example.com:7051",
		testIdentity,
		testSigner{},
		WithDiscoverySeed("peer1.example.com:8051"),
		WithGatewayTLS(TLSOptions{SslTargetNameOverride: "gateway.example.com"}),
		WithDiscoveryTLS(TLSOptions{SslTargetNameOverride: "peer1.example.com"}),
		WithOrderer("orderer.example.com:7050"),
		WithOrdererTLS(TLSOptions{SslTargetNameOverride: "orderer.example.com"}),
	)

	if cfg.DiscoverySeed != "peer1.example.com:8051" {
		t.Fatalf("discovery seed mismatch: %q", cfg.DiscoverySeed)
	}
	if cfg.DiscoveryTLS.SslTargetNameOverride != "peer1.example.com" {
		t.Fatalf("discovery TLS override mismatch: %q", cfg.DiscoveryTLS.SslTargetNameOverride)
	}
	if cfg.OrdererEndpoint != "orderer.example.com:7050" {
		t.Fatalf("orderer endpoint mismatch: %q", cfg.OrdererEndpoint)
	}
	if cfg.OrdererTLS.SslTargetNameOverride != "orderer.example.com" {
		t.Fatalf("orderer TLS override mismatch: %q", cfg.OrdererTLS.SslTargetNameOverride)
	}
}

func TestConfigValidateReportsTLSRoleErrors(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want string
	}{
		{
			name: "gateway TLS",
			cfg: NewConfig("gateway.example.com:7051", testIdentity, testSigner{},
				WithGatewayTLS(TLSOptions{TrustedRoots: []byte("not pem")}),
			),
			want: "gatewayTls.TrustedRoots",
		},
		{
			name: "discovery TLS",
			cfg: NewConfig("gateway.example.com:7051", testIdentity, testSigner{},
				WithDiscoveryTLS(TLSOptions{TrustedRoots: []byte("not pem")}),
			),
			want: "discoveryTls.TrustedRoots",
		},
		{
			name: "orderer TLS",
			cfg: NewConfig("gateway.example.com:7051", testIdentity, testSigner{},
				WithOrdererTLS(TLSOptions{TrustedRoots: []byte("not pem")}),
			),
			want: "ordererTls.TrustedRoots",
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if err == nil {
				t.Fatal("expected validation error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected error to contain %q, got %q", tt.want, err.Error())
			}
		})
	}
}
