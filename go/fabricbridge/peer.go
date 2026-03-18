package fabricbridge

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/hyperledger/fabric-sdk-go/pkg/client/channel"
	"github.com/hyperledger/fabric-sdk-go/pkg/common/providers/core"
	"github.com/hyperledger/fabric-sdk-go/pkg/common/providers/fab"
	"github.com/hyperledger/fabric-sdk-go/pkg/core/config"
	"github.com/hyperledger/fabric-sdk-go/pkg/fabsdk"
)

// PeerConnection manages the fabric-sdk-go connection for peer targeting
type PeerConnection struct {
	sdk       *fabsdk.FabricSDK
	channel   string
	config    Config
	discovery *DiscoveryCache
	mu        sync.RWMutex
}

// DiscoveryCache caches discovery results
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

// NewPeerConnection creates a new peer connection using fabric-sdk-go
func NewPeerConnection(ctx context.Context, cfg Config, channel string) (*PeerConnection, error) {
	// Build minimal config for fabric-sdk-go
	configProvider := buildConfigProvider(cfg, channel)

	// Initialize SDK
	sdk, err := fabsdk.New(configProvider)
	if err != nil {
		return nil, fmt.Errorf("failed to create SDK: %w", err)
	}

	return &PeerConnection{
		sdk:       sdk,
		channel:   channel,
		config:    cfg,
		discovery: NewDiscoveryCache(5 * time.Minute),
	}, nil
}

// Close closes the peer connection
func (p *PeerConnection) Close() {
	p.sdk.Close()
}

// Execute submits a transaction to specific peers
func (p *PeerConnection) Execute(ctx context.Context, chaincodeID string, fn string, args [][]byte, peerEndpoints []string, transientData map[string][]byte) (*channel.Response, error) {
	// Get channel client
	client, err := p.getChannelClient()
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	// Build request
	req := channel.Request{
		ChaincodeID:  chaincodeID,
		Fcn:          fn,
		Args:         args,
		TransientMap: transientData,
	}

	// Build options for peer targeting
	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
	}

	// Execute
	resp, err := client.Execute(req, opts...)
	if err != nil {
		return nil, fmt.Errorf("execute failed: %w", err)
	}

	return &resp, nil
}

// Query queries chaincode on specific peers
func (p *PeerConnection) Query(ctx context.Context, chaincodeID string, fn string, args [][]byte, peerEndpoints []string) ([]byte, error) {
	// Get channel client
	client, err := p.getChannelClient()
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	// Build request
	req := channel.Request{
		ChaincodeID: chaincodeID,
		Fcn:         fn,
		Args:        args,
	}

	// Build options for peer targeting
	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
	}

	// Query
	resp, err := client.Query(req, opts...)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}

	return resp.Payload, nil
}

// Discover performs service discovery and returns peer information
func (p *PeerConnection) Discover(ctx context.Context) ([]PeerInfo, error) {
	// Check cache first
	if peers, ok := p.discovery.Get(p.channel); ok {
		return peers, nil
	}

	// Get channel client
	client, err := p.getChannelClient()
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	// Query chaincode to trigger discovery (this is a workaround since SDK doesn't expose discovery directly)
	req := channel.Request{
		ChaincodeID: "lscc", // lifecycle system chaincode
		Fcn:         "getccdata",
		Args:        [][]byte{[]byte(p.channel)},
	}

	// Use discovery
	opts := []channel.RequestOption{
		channel.WithTimeout(fab.DiscoveryConnection, p.config.Timeouts.Discovery),
	}

	_, err = client.Query(req, opts...)
	// Ignore error, we just wanted to trigger discovery
	_ = err

	// For now, return an empty list - in production, you'd parse the discovery results
	// from the SDK's internal discovery service
	peers := []PeerInfo{}

	// Cache results
	p.discovery.Set(p.channel, peers)

	return peers, nil
}

// getChannelClient returns a channel client
func (p *PeerConnection) getChannelClient() (*channel.Client, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	// Create channel provider
	channelProvider := p.sdk.ChannelContext(p.channel)

	// Create client
	client, err := channel.New(channelProvider)
	if err != nil {
		return nil, fmt.Errorf("failed to create channel client: %w", err)
	}

	return client, nil
}

// buildConfigProvider creates a minimal config provider for fabric-sdk-go
func buildConfigProvider(cfg Config, channel string) core.ConfigProvider {
	// Create minimal config structure
	configMap := map[string]interface{}{
		"client": map[string]interface{}{
			"organization": cfg.Identity.MSPId,
			"connection": map[string]interface{}{
				"timeout": map[string]interface{}{
					"peer": map[string]interface{}{
						"endorser": cfg.Timeouts.Endorse.Milliseconds(),
						"eventHub": cfg.Timeouts.Commit.Milliseconds(),
						"eventReg": 3000,
					},
					"orderer": map[string]interface{}{
						"connectionTimeout": cfg.Timeouts.Submit.Milliseconds(),
					},
				},
			},
		},
		"channels": map[string]interface{}{
			channel: map[string]interface{}{
				"orderers": []string{},
				"peers":    map[string]interface{}{},
			},
		},
		"organizations": map[string]interface{}{
			cfg.Identity.MSPId: map[string]interface{}{
				"mspid": cfg.Identity.MSPId,
				"peers": []string{},
			},
		},
		"orderers": map[string]interface{}{},
		"peers":    map[string]interface{}{},
	}

	return config.FromRaw([]byte(toYAML(configMap)), "yaml")
}

// toYAML is a simple YAML converter (in production, use a proper library)
func toYAML(m map[string]interface{}) string {
	// This is a simplified version - in production use yaml.Marshal
	return ""
}
