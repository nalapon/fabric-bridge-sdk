package fabricbridge

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"sort"

	discoveryProto "github.com/hyperledger/fabric-protos-go-apiv2/discovery"
	gossipProto "github.com/hyperledger/fabric-protos-go-apiv2/gossip"
	mspProto "github.com/hyperledger/fabric-protos-go-apiv2/msp"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
)

type directDiscoveryClient struct {
	config Config
}

type directDiscoveredPeer struct {
	url        string
	mspID      string
	properties peerProperties
	config     Config
}

func newDirectDiscoveryClient(cfg Config) *directDiscoveryClient {
	return &directDiscoveryClient{config: cfg.normalized()}
}

func (c *directDiscoveryClient) DiscoverPeers(ctx context.Context, channelName string) ([]peerTarget, error) {
	cfg := c.config.normalized()
	if timeout := cfg.Timeouts.Discovery; timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	conn, err := createGRPCConnectionTo(cfg.DiscoverySeed, cfg.DiscoveryTLS)
	if err != nil {
		return nil, &DiscoveryError{Message: "create discovery connection", Cause: err}
	}
	defer conn.Close()

	request, err := newSignedDiscoveryRequest(cfg, channelName)
	if err != nil {
		return nil, &DiscoveryError{Message: "build discovery request", Cause: err}
	}

	response, err := discoveryProto.NewDiscoveryClient(conn).Discover(ctx, request)
	if err != nil {
		return nil, &DiscoveryError{Message: fmt.Sprintf("discover peers from %s", cfg.DiscoverySeed), Cause: err}
	}

	peers, err := discoveredPeersFromResponse(response, cfg)
	if err != nil {
		return nil, &DiscoveryError{Message: "parse discovery response", Cause: err}
	}
	return peers, nil
}

func newSignedDiscoveryRequest(cfg Config, channelName string) (*discoveryProto.SignedRequest, error) {
	identity, err := proto.Marshal(&mspProto.SerializedIdentity{
		Mspid:   cfg.Identity.MSPId,
		IdBytes: cfg.Identity.Certificate,
	})
	if err != nil {
		return nil, fmt.Errorf("serialize bridge identity: %w", err)
	}

	request := &discoveryProto.Request{
		Authentication: &discoveryProto.AuthInfo{
			ClientIdentity:    identity,
			ClientTlsCertHash: discoveryTLSCertHash(cfg.DiscoveryTLS),
		},
		Queries: []*discoveryProto.Query{
			{
				Channel: channelName,
				Query: &discoveryProto.Query_PeerQuery{
					PeerQuery: &discoveryProto.PeerMembershipQuery{},
				},
			},
		},
	}
	payload, err := proto.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	digest := sha256.Sum256(payload)
	signature, err := cfg.Signer.Sign(digest[:])
	if err != nil {
		return nil, fmt.Errorf("sign request: %w", err)
	}

	return &discoveryProto.SignedRequest{
		Payload:   payload,
		Signature: signature,
	}, nil
}

func discoveryTLSCertHash(tlsOptions *TLSOptions) []byte {
	if tlsOptions == nil || len(tlsOptions.ClientCert) == 0 {
		digest := sha256.Sum256(nil)
		return digest[:]
	}
	cert, err := tls.X509KeyPair(tlsOptions.ClientCert, tlsOptions.ClientKey)
	if err != nil || len(cert.Certificate) == 0 {
		digest := sha256.Sum256(nil)
		return digest[:]
	}
	digest := sha256.Sum256(cert.Certificate[0])
	return digest[:]
}

func discoveredPeersFromResponse(response *discoveryProto.Response, cfg Config) ([]peerTarget, error) {
	if response == nil {
		return nil, fmt.Errorf("empty discovery response")
	}
	if len(response.GetResults()) != 1 {
		return nil, fmt.Errorf("expected 1 discovery result, got %d", len(response.GetResults()))
	}

	result := response.GetResults()[0]
	if discoveryError := result.GetError(); discoveryError != nil {
		return nil, fmt.Errorf("discovery service error: %s", discoveryError.GetContent())
	}
	members := result.GetMembers()
	if members == nil {
		return nil, fmt.Errorf("expected peer membership result")
	}

	orgIDs := make([]string, 0, len(members.GetPeersByOrg()))
	for orgID := range members.GetPeersByOrg() {
		orgIDs = append(orgIDs, orgID)
	}
	sort.Strings(orgIDs)

	var peers []peerTarget
	for _, orgID := range orgIDs {
		for _, peer := range members.GetPeersByOrg()[orgID].GetPeers() {
			endpoint, err := peerEndpointFromDiscoveryPeer(peer)
			if err != nil {
				return nil, err
			}
			peers = append(peers, &directDiscoveredPeer{
				url:        endpoint,
				mspID:      orgID,
				properties: discoveryPeerProperties(peer),
				config:     cfg,
			})
		}
	}
	return peers, nil
}

func peerEndpointFromDiscoveryPeer(peer *discoveryProto.Peer) (string, error) {
	if peer == nil || peer.GetMembershipInfo() == nil {
		return "", fmt.Errorf("discovered peer has no membership info")
	}
	message := &gossipProto.GossipMessage{}
	if err := proto.Unmarshal(peer.GetMembershipInfo().GetPayload(), message); err != nil {
		return "", fmt.Errorf("unmarshal peer membership info: %w", err)
	}
	endpoint := message.GetAliveMsg().GetMembership().GetEndpoint()
	if endpoint == "" {
		return "", fmt.Errorf("discovered peer has no endpoint")
	}
	return endpoint, nil
}

func discoveryPeerProperties(peer *discoveryProto.Peer) peerProperties {
	if peer == nil || peer.GetStateInfo() == nil {
		return nil
	}
	message := &gossipProto.GossipMessage{}
	if err := proto.Unmarshal(peer.GetStateInfo().GetPayload(), message); err != nil {
		return nil
	}
	properties := message.GetStateInfo().GetProperties()
	if properties == nil {
		return nil
	}
	out := peerProperties{}
	out[peerPropertyLedgerHeight] = properties.GetLedgerHeight()
	out[peerPropertyLeftChannel] = properties.GetLeftChannel()
	out[peerPropertyChaincodes] = properties.GetChaincodes()
	return out
}

func (p *directDiscoveredPeer) MSPID() string {
	return p.mspID
}

func (p *directDiscoveredPeer) URL() string {
	return p.url
}

func (p *directDiscoveredPeer) Properties() peerProperties {
	return p.properties
}

func (p *directDiscoveredPeer) ProcessTransactionProposal(ctx context.Context, request processProposalRequest) (*proposalResponse, error) {
	cfg := p.config.normalized()
	conn, err := createGRPCConnectionTo(p.url, cfg.DiscoveryTLS)
	if err != nil {
		return &proposalResponse{Endorser: p.url}, err
	}
	defer conn.Close()

	response, err := peerProto.NewEndorserClient(conn).ProcessProposal(ctx, request.SignedProposal)
	if err != nil {
		return &proposalResponse{Endorser: p.url}, err
	}
	status := response.GetResponse().GetStatus()
	return &proposalResponse{
		Endorser:         p.url,
		Status:           status,
		ChaincodeStatus:  status,
		ProposalResponse: response,
	}, nil
}

var _ peerTarget = (*directDiscoveredPeer)(nil)
