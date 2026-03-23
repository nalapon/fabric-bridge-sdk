package fabricbridge

import (
	"context"
	"encoding/pem"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/hyperledger/fabric-sdk-go/pkg/client/channel"
	"github.com/hyperledger/fabric-sdk-go/pkg/client/channel/invoke"
	"github.com/hyperledger/fabric-sdk-go/pkg/common/providers/core"
	"github.com/hyperledger/fabric-sdk-go/pkg/core/config"
	"github.com/hyperledger/fabric-sdk-go/pkg/fabsdk"
	"gopkg.in/yaml.v2"
)

// PeerConnection manages the fabric-sdk-go connection for peer targeting.
// It connects directly to peers via the Endorser gRPC service (NOT the Gateway service).
type PeerConnection struct {
	sdk     *fabsdk.FabricSDK
	channel string
	config  Config
	mu      sync.RWMutex
}

// NewPeerConnection creates a new peer connection using fabric-sdk-go.
// channelName is used to build the connection profile (channels section).
func NewPeerConnection(cfg Config, channelName string) (*PeerConnection, error) {
	configProvider := buildConfigProvider(cfg, channelName)

	sdk, err := fabsdk.New(configProvider)
	if err != nil {
		return nil, fmt.Errorf("failed to create SDK: %w", err)
	}

	return &PeerConnection{
		sdk:    sdk,
		config: cfg,
	}, nil
}

// Close closes the peer connection and releases all resources
func (p *PeerConnection) Close() {
	if p.sdk != nil {
		p.sdk.Close()
	}
}

// Execute submits a transaction to specific peers (endorse + orderer commit).
// Requires orderer configuration in the config provider.
func (p *PeerConnection) Execute(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peerEndpoints []string, transientData map[string][]byte) (*channel.Response, error) {
	client, err := p.getChannelClient(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	req := channel.Request{
		ChaincodeID:  chaincodeID,
		Fcn:          fn,
		Args:         args,
		TransientMap: transientData,
	}

	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
	}

	resp, err := client.Execute(req, opts...)
	if err != nil {
		return nil, fmt.Errorf("execute failed: %w", err)
	}

	return &resp, nil
}

// Endorse sends a transaction proposal to specific peers for endorsement only (no commit).
// Supports transient data. Does NOT require orderer configuration.
func (p *PeerConnection) Endorse(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peerEndpoints []string, transientData map[string][]byte) (*channel.Response, error) {
	client, err := p.getChannelClient(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	req := channel.Request{
		ChaincodeID:  chaincodeID,
		Fcn:          fn,
		Args:         args,
		TransientMap: transientData,
	}

	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
	}

	// Use SelectAndEndorseHandler chain: endorsement only, no commit
	handler := invoke.NewSelectAndEndorseHandler(
		invoke.NewEndorsementValidationHandler(
			invoke.NewSignatureValidationHandler(),
		),
	)

	resp, err := client.InvokeHandler(handler, req, opts...)
	if err != nil {
		return nil, fmt.Errorf("endorse failed: %w", err)
	}

	return &resp, nil
}

// Query queries chaincode on specific peers (read-only, endorsement only)
func (p *PeerConnection) Query(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peerEndpoints []string) ([]byte, error) {
	client, err := p.getChannelClient(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	req := channel.Request{
		ChaincodeID: chaincodeID,
		Fcn:         fn,
		Args:        args,
	}

	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
	}

	resp, err := client.Query(req, opts...)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}

	return resp.Payload, nil
}

// getChannelClient returns a channel client for the specified channel
func (p *PeerConnection) getChannelClient(channelName string) (*channel.Client, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	channelProvider := p.sdk.ChannelContext(channelName, fabsdk.WithUser("BridgeUser"))
	client, err := channel.New(channelProvider)
	if err != nil {
		return nil, fmt.Errorf("failed to create channel client: %w", err)
	}

	return client, nil
}

// buildConfigProvider creates a minimal connection profile for fabric-sdk-go.
// The config is built as a Go map and marshaled to YAML.
func buildConfigProvider(cfg Config, channelName string) core.ConfigProvider {
	peerName := peerName(cfg)
	peerURL := peerURL(cfg)

	peerEntry := map[string]interface{}{
		"url": peerURL,
	}

	grpcOptions := map[string]interface{}{}
	if cfg.TLSOptions != nil && cfg.TLSOptions.SslTargetNameOverride != "" {
		grpcOptions["ssl-target-name-override"] = cfg.TLSOptions.SslTargetNameOverride
	}
	if len(grpcOptions) > 0 {
		peerEntry["grpcOptions"] = grpcOptions
	}

	if cfg.TLSOptions != nil && len(cfg.TLSOptions.TrustedRoots) > 0 {
		peerEntry["tlsCACerts"] = map[string]interface{}{
			"pem": string(cfg.TLSOptions.TrustedRoots),
		}
	}

	peers := map[string]interface{}{
		peerName: peerEntry,
	}

	// Encode DER certificate to PEM format for the connection profile.
	// Identity.Certificate is DER (from x509.ParseCertificate in gateway mode),
	// but fabric-sdk-go expects PEM in the YAML config.
	certPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: cfg.Identity.Certificate,
	})

	orgName := strings.ToLower(cfg.Identity.MSPId)
	orgEntry := map[string]interface{}{
		"mspid": cfg.Identity.MSPId,
		"peers": []string{peerName},
		"users": map[string]interface{}{
			"BridgeUser": map[string]interface{}{
				"key": map[string]interface{}{
					"pem": string(cfg.Identity.PrivateKey),
				},
				"cert": map[string]interface{}{
					"pem": string(certPEM),
				},
			},
		},
	}

	channelPeers := map[string]interface{}{
		peerName: map[string]interface{}{
			"endorsingPeer":  true,
			"chaincodeQuery": true,
			"ledgerQuery":    true,
			"eventSource":    true,
		},
	}

	channelEntry := map[string]interface{}{
		"peers": channelPeers,
	}

	orderers := map[string]interface{}{}
	var ordName string

	if cfg.OrdererEndpoint != "" {
		ordName = ordererName(cfg)
		ordererURLOrder := ordererURL(cfg)

		ordererEntry := map[string]interface{}{
			"url": ordererURLOrder,
		}

		ordererGrpcOptions := map[string]interface{}{}
		if cfg.TLSOptions != nil && cfg.TLSOptions.SslTargetNameOverride != "" {
			ordererGrpcOptions["ssl-target-name-override"] = cfg.TLSOptions.SslTargetNameOverride
		}
		if len(ordererGrpcOptions) > 0 {
			ordererEntry["grpcOptions"] = ordererGrpcOptions
		}

		if cfg.TLSOptions != nil && len(cfg.TLSOptions.TrustedRoots) > 0 {
			ordererEntry["tlsCACerts"] = map[string]interface{}{
				"pem": string(cfg.TLSOptions.TrustedRoots),
			}
		}

		orderers[ordName] = ordererEntry
		channelEntry["orderers"] = []string{ordName}
	}

	configMap := map[string]interface{}{
		"version": "1.0.0",
		"client": map[string]interface{}{
			"organization": orgName,
			"logging": map[string]interface{}{
				"level": "info",
			},
		},
		"organizations": map[string]interface{}{
			orgName: orgEntry,
		},
		"peers": peers,
	}

	if cfg.OrdererEndpoint != "" {
		configMap["orderers"] = orderers
	}

	configMap["channels"] = map[string]interface{}{
		channelName: channelEntry,
	}

	yamlBytes, err := yaml.Marshal(configMap)
	if err != nil {
		// This should never happen with a valid map
		panic(fmt.Sprintf("failed to marshal config to YAML: %v", err))
	}

	return config.FromRaw(yamlBytes, "yaml")
}

// peerName returns the logical name for the peer in the connection profile.
// Uses SslTargetNameOverride if set, otherwise extracts hostname from the endpoint.
func peerName(cfg Config) string {
	if cfg.TLSOptions != nil && cfg.TLSOptions.SslTargetNameOverride != "" {
		return cfg.TLSOptions.SslTargetNameOverride
	}
	return extractHost(cfg.GatewayPeer)
}

// peerURL returns the full URL for the peer with protocol prefix.
func peerURL(cfg Config) string {
	host := cfg.GatewayPeer
	if cfg.TLSOptions != nil && len(cfg.TLSOptions.TrustedRoots) > 0 {
		if !strings.HasPrefix(host, "grpcs://") && !strings.HasPrefix(host, "grpc://") {
			return "grpcs://" + host
		}
	} else {
		if !strings.HasPrefix(host, "grpcs://") && !strings.HasPrefix(host, "grpc://") {
			return "grpc://" + host
		}
	}
	return host
}

// ordererName returns the logical name for the orderer in the connection profile.
func ordererName(cfg Config) string {
	if cfg.TLSOptions != nil && cfg.TLSOptions.SslTargetNameOverride != "" {
		return cfg.TLSOptions.SslTargetNameOverride
	}
	return extractHost(cfg.OrdererEndpoint)
}

// ordererURL returns the full URL for the orderer with protocol prefix.
func ordererURL(cfg Config) string {
	host := cfg.OrdererEndpoint
	if cfg.TLSOptions != nil && len(cfg.TLSOptions.TrustedRoots) > 0 {
		if !strings.HasPrefix(host, "grpcs://") && !strings.HasPrefix(host, "grpc://") {
			return "grpcs://" + host
		}
	} else {
		if !strings.HasPrefix(host, "grpcs://") && !strings.HasPrefix(host, "grpc://") {
			return "grpc://" + host
		}
	}
	return host
}

// extractHost extracts the hostname from a host:port string
func extractHost(endpoint string) string {
	host := endpoint
	if strings.HasPrefix(host, "grpcs://") {
		host = strings.TrimPrefix(host, "grpcs://")
	} else if strings.HasPrefix(host, "grpc://") {
		host = strings.TrimPrefix(host, "grpc://")
	}
	if idx := strings.Index(host, ":"); idx > 0 {
		return host[:idx]
	}
	return host
}

// DiscoveryCache caches discovery results (kept for compatibility, not used in sequential mode)
type DiscoveryCache struct {
	mu         sync.RWMutex
	peers      map[string][]PeerInfo
	lastUpdate time.Time
	ttl        time.Duration
}

// PeerInfo represents information about a peer
type PeerInfo struct {
	Name       string
	Endpoint   string
	MSPID      string
	Chaincodes []string
}

// NewDiscoveryCache creates a new discovery cache
func NewDiscoveryCache(ttl time.Duration) *DiscoveryCache {
	return &DiscoveryCache{
		peers: make(map[string][]PeerInfo),
		ttl:   ttl,
	}
}

// Get returns cached peers for a channel
func (c *DiscoveryCache) Get(channel string) ([]PeerInfo, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if time.Since(c.lastUpdate) > c.ttl {
		return nil, false
	}

	peers, ok := c.peers[channel]
	return peers, ok
}

// Set caches peers for a channel
func (c *DiscoveryCache) Set(channel string, peers []PeerInfo) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.peers[channel] = peers
	c.lastUpdate = time.Now()
}
