package fabricbridge

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/client/channel"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/client/channel/invoke"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/client/common/discovery/staticdiscovery"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/core"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/core/config"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fab/events/deliverclient"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fabsdk"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fabsdk/provider/chpvdr"
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

type peerSubmittedTransaction struct {
	response      *channel.Response
	waitForCommit func(ctx context.Context) (*CommitStatus, error)
}

type pendingPeerCommit struct {
	eventService   fab.EventService
	registration   fab.Registration
	statusNotifier <-chan *fab.TxStatusEvent
	closeFunc      func()
	once           sync.Once
}

func (p *pendingPeerCommit) close() {
	if p == nil || p.eventService == nil {
		return
	}

	p.once.Do(func() {
		p.eventService.Unregister(p.registration)
		if p.closeFunc != nil {
			p.closeFunc()
		}
	})
}

type legacyCommitMonitor struct {
	txID   string
	done   chan struct{}
	status *CommitStatus
	err    error
}

func newLegacyCommitMonitor(pc *PeerConnection, txID string, pending *pendingPeerCommit) *legacyCommitMonitor {
	monitor := &legacyCommitMonitor{
		txID: txID,
		done: make(chan struct{}),
	}

	go func() {
		defer close(monitor.done)
		defer pending.close()
		defer pc.Close()

		txStatus, ok := <-pending.statusNotifier
		if !ok {
			monitor.err = &CommitError{
				Message:       "transaction status notifier closed before commit event was received",
				TransactionID: txID,
			}
			return
		}

		monitor.status = &CommitStatus{
			BlockNumber:   txStatus.BlockNumber,
			Status:        txStatus.TxValidationCode,
			TransactionID: txID,
		}

		if txStatus.TxValidationCode != peerProto.TxValidationCode_VALID {
			monitor.err = &CommitError{
				Message:       "transaction committed with invalid validation code",
				TransactionID: txID,
				Status:        txStatus.TxValidationCode.String(),
			}
		}
	}()

	return monitor
}

func (m *legacyCommitMonitor) Wait(ctx context.Context) (*CommitStatus, error) {
	select {
	case <-m.done:
		return m.status, m.err
	case <-ctx.Done():
		return nil, &CommitError{
			Message:       fmt.Sprintf("wait for commit: %v", ctx.Err()),
			TransactionID: m.txID,
		}
	}
}

// NewPeerConnection creates a peer connection. The broad legacy SDK runtime is initialized lazily
// only for paths that still need legacy channel/orderer/event handling.
func NewPeerConnection(cfg Config, channelName string) (*PeerConnection, error) {
	return &PeerConnection{
		channel: channelName,
		config:  cfg.normalized(),
	}, nil
}

// Close closes the peer connection and releases all resources
func (p *PeerConnection) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sdk != nil {
		p.sdk.Close()
		p.sdk = nil
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
		channel.WithParentContext(ctx),
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
		channel.WithParentContext(ctx),
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
func (p *PeerConnection) Query(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peerEndpoints []string, transientData ...map[string][]byte) ([]byte, error) {
	client, err := p.getChannelClient(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	req := channel.Request{
		ChaincodeID: chaincodeID,
		Fcn:         fn,
		Args:        args,
	}

	if len(transientData) > 0 && len(transientData[0]) > 0 {
		req.TransientMap = transientData[0]
	}

	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
		channel.WithParentContext(ctx),
	}

	resp, err := client.Query(req, opts...)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}

	return resp.Payload, nil
}

// QueryTargets queries chaincode on specific discovered peer objects.
func (p *PeerConnection) QueryTargets(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peers []fab.Peer, transientData map[string][]byte) ([]byte, error) {
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
		channel.WithTargets(peers...),
		channel.WithParentContext(ctx),
	}

	resp, err := client.Query(req, opts...)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}

	return resp.Payload, nil
}

// SubmitAsync submits a transaction to the orderer and returns a legacy commit waiter.
func (p *PeerConnection) SubmitAsync(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peerEndpoints []string, transientData map[string][]byte) (*peerSubmittedTransaction, error) {
	client, err := p.getChannelClient(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	eventService, closeEventService, err := p.getTxStatusEventService(channelName)
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("failed to create tx status event service: %w", err)
	}

	req := channel.Request{
		ChaincodeID:  chaincodeID,
		Fcn:          fn,
		Args:         args,
		TransientMap: transientData,
	}

	opts := []channel.RequestOption{
		channel.WithTargetEndpoints(peerEndpoints...),
		channel.WithParentContext(ctx),
	}

	submitHandler := &submitTxHandler{
		eventService: eventService,
		closeFunc:    closeEventService,
	}
	handler := invoke.NewSelectAndEndorseHandler(
		invoke.NewEndorsementValidationHandler(
			invoke.NewSignatureValidationHandler(submitHandler),
		),
	)

	resp, err := client.InvokeHandler(handler, req, opts...)
	if err != nil {
		if submitHandler.pending != nil {
			submitHandler.pending.close()
		}
		p.Close()
		return nil, fmt.Errorf("submit async failed: %w", err)
	}

	if submitHandler.pending == nil {
		p.Close()
		return nil, fmt.Errorf("submit async failed: commit event registration was not initialized")
	}

	monitor := newLegacyCommitMonitor(p, string(resp.TransactionID), submitHandler.pending)

	return &peerSubmittedTransaction{
		response:      &resp,
		waitForCommit: monitor.Wait,
	}, nil
}

// SubmitAsyncTargets submits using specific discovered peer objects.
func (p *PeerConnection) SubmitAsyncTargets(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peers []fab.Peer, transientData map[string][]byte) (*peerSubmittedTransaction, error) {
	client, err := p.getChannelClient(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel client: %w", err)
	}

	eventService, closeEventService, err := p.getTxStatusEventService(channelName)
	if err != nil {
		return nil, fmt.Errorf("failed to create tx status event service: %w", err)
	}

	req := channel.Request{
		ChaincodeID:  chaincodeID,
		Fcn:          fn,
		Args:         args,
		TransientMap: transientData,
	}

	opts := []channel.RequestOption{
		channel.WithTargets(peers...),
		channel.WithParentContext(ctx),
	}

	submitHandler := &submitTxHandler{
		eventService: eventService,
		closeFunc:    closeEventService,
	}
	handler := invoke.NewSelectAndEndorseHandler(
		invoke.NewEndorsementValidationHandler(
			invoke.NewSignatureValidationHandler(submitHandler),
		),
	)

	resp, err := client.InvokeHandler(handler, req, opts...)
	if err != nil {
		if submitHandler.pending != nil {
			submitHandler.pending.close()
		} else if closeEventService != nil {
			closeEventService()
		}
		return nil, fmt.Errorf("submit async failed: %w", err)
	}

	if submitHandler.pending == nil {
		if closeEventService != nil {
			closeEventService()
		}
		return nil, fmt.Errorf("submit async failed: commit event registration was not initialized")
	}

	monitor := newLegacyCommitMonitor(p, string(resp.TransactionID), submitHandler.pending)

	return &peerSubmittedTransaction{
		response:      &resp,
		waitForCommit: monitor.Wait,
	}, nil
}

// getChannelClient returns a channel client for the specified channel
func (p *PeerConnection) getChannelClient(channelName string) (*channel.Client, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if err := p.ensureLegacySDK(channelName); err != nil {
		return nil, err
	}

	channelProvider := p.sdk.ChannelContext(channelName, fabsdk.WithIdentity(newBridgeSigningIdentity(p.config)))
	client, err := channel.New(channelProvider)
	if err != nil {
		return nil, fmt.Errorf("failed to create channel client: %w", err)
	}

	return client, nil
}

// DiscoverPeers returns channel peers from direct Fabric service discovery.
func (p *PeerConnection) DiscoverPeers(channelName string) ([]fab.Peer, error) {
	return newDirectDiscoveryClient(p.config).DiscoverPeers(context.Background(), channelName)
}

func (p *PeerConnection) getTxStatusEventService(channelName string) (fab.EventService, func(), error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if err := p.ensureLegacySDK(channelName); err != nil {
		return nil, nil, err
	}

	channelProvider := p.sdk.ChannelContext(channelName, fabsdk.WithIdentity(newBridgeSigningIdentity(p.config)))
	channelContext, err := channelProvider()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create channel context: %w", err)
	}

	chConfig, err := channelContext.ChannelService().ChannelConfig()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get channel config: %w", err)
	}

	discoveryService, err := staticdiscovery.NewService(channelContext.EndpointConfig(), channelContext.InfraProvider(), channelName)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create static discovery service: %w", err)
	}

	eventClientRef := chpvdr.NewEventClientRef(
		p.config.Timeouts.Commit,
		func() (fab.EventClient, error) {
			return deliverclient.New(channelContext, chConfig, discoveryService)
		},
	)

	return eventClientRef, eventClientRef.Close, nil
}

func (p *PeerConnection) ensureLegacySDK(channelName string) error {
	if p.sdk != nil {
		return nil
	}

	sdk, err := fabsdk.New(buildConfigProvider(p.config, channelName))
	if err != nil {
		return fmt.Errorf("failed to create SDK: %w", err)
	}
	p.sdk = sdk
	return nil
}

// buildConfigProvider creates a minimal connection profile for fabric-sdk-go.
// The config is built as a Go map and marshaled to YAML.
func buildConfigProvider(cfg Config, channelName string) core.ConfigProvider {
	cfg = cfg.normalized()
	peerName := peerName(cfg)
	peerURL := peerURL(cfg)

	peerEntry := map[string]interface{}{
		"url": peerURL,
	}

	grpcOptions := map[string]interface{}{}
	if cfg.DiscoveryTLS != nil && cfg.DiscoveryTLS.SslTargetNameOverride != "" {
		grpcOptions["ssl-target-name-override"] = cfg.DiscoveryTLS.SslTargetNameOverride
	}
	if len(grpcOptions) > 0 {
		peerEntry["grpcOptions"] = grpcOptions
	}

	if cfg.DiscoveryTLS != nil && len(cfg.DiscoveryTLS.TrustedRoots) > 0 {
		peerEntry["tlsCACerts"] = map[string]interface{}{
			"pem": string(cfg.DiscoveryTLS.TrustedRoots),
		}
	}

	peers := map[string]interface{}{
		peerName: peerEntry,
	}

	orgName := strings.ToLower(cfg.Identity.MSPId)
	orgEntry := map[string]interface{}{
		"mspid": cfg.Identity.MSPId,
		"peers": []string{peerName},
		"users": map[string]interface{}{},
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
		ordererTLSOptions := ordererTLSOptions(cfg)

		ordererEntry := map[string]interface{}{
			"url": ordererURLOrder,
		}

		ordererGrpcOptions := map[string]interface{}{}
		if ordererTLSOptions != nil && ordererTLSOptions.SslTargetNameOverride != "" {
			ordererGrpcOptions["ssl-target-name-override"] = ordererTLSOptions.SslTargetNameOverride
		}
		if len(ordererGrpcOptions) > 0 {
			ordererEntry["grpcOptions"] = ordererGrpcOptions
		}

		if ordererTLSOptions != nil && len(ordererTLSOptions.TrustedRoots) > 0 {
			ordererEntry["tlsCACerts"] = map[string]interface{}{
				"pem": string(ordererTLSOptions.TrustedRoots),
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

type submitTxHandler struct {
	eventService fab.EventService
	closeFunc    func()
	pending      *pendingPeerCommit
}

func (h *submitTxHandler) Handle(requestContext *invoke.RequestContext, clientContext *invoke.ClientContext) {
	txnRequest := fab.TransactionRequest{
		Proposal:          requestContext.Response.Proposal,
		ProposalResponses: requestContext.Response.Responses,
	}

	txnID := string(requestContext.Response.TransactionID)

	reg, statusNotifier, err := h.eventService.RegisterTxStatusEvent(txnID)
	if err != nil {
		if h.closeFunc != nil {
			h.closeFunc()
		}
		requestContext.Error = fmt.Errorf("register tx status event failed: %w", err)
		return
	}

	pending := &pendingPeerCommit{
		eventService:   h.eventService,
		registration:   reg,
		statusNotifier: statusNotifier,
		closeFunc:      h.closeFunc,
	}

	tx, err := clientContext.Transactor.CreateTransaction(txnRequest)
	if err != nil {
		pending.close()
		requestContext.Error = fmt.Errorf("create transaction failed: %w", err)
		return
	}

	if _, err := clientContext.Transactor.SendTransaction(tx); err != nil {
		pending.close()
		requestContext.Error = fmt.Errorf("send transaction failed: %w", err)
		return
	}

	h.pending = pending
}

// peerName returns the logical name for the peer in the connection profile.
// Uses SslTargetNameOverride if set, otherwise extracts hostname from the endpoint.
func peerName(cfg Config) string {
	if cfg.DiscoveryTLS != nil && cfg.DiscoveryTLS.SslTargetNameOverride != "" {
		return cfg.DiscoveryTLS.SslTargetNameOverride
	}
	return extractHost(cfg.DiscoverySeed)
}

// peerURL returns the full URL for the peer with protocol prefix.
func peerURL(cfg Config) string {
	host := cfg.DiscoverySeed
	if cfg.DiscoveryTLS != nil && len(cfg.DiscoveryTLS.TrustedRoots) > 0 {
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
	if ordererTLSOptions := ordererTLSOptions(cfg); ordererTLSOptions != nil && ordererTLSOptions.SslTargetNameOverride != "" {
		return ordererTLSOptions.SslTargetNameOverride
	}
	return extractHost(cfg.OrdererEndpoint)
}

// ordererURL returns the full URL for the orderer with protocol prefix.
func ordererURL(cfg Config) string {
	host := cfg.OrdererEndpoint
	if ordererTLSOptions := ordererTLSOptions(cfg); ordererTLSOptions != nil && len(ordererTLSOptions.TrustedRoots) > 0 {
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

func ordererTLSOptions(cfg Config) *TLSOptions {
	return cfg.OrdererTLS
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
