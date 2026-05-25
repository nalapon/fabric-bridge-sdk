package fabricbridge

import (
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	discoveryProto "github.com/hyperledger/fabric-protos-go-apiv2/discovery"
	gossipProto "github.com/hyperledger/fabric-protos-go-apiv2/gossip"
	mspProto "github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type captureDiscoveryServer struct {
	discoveryProto.UnimplementedDiscoveryServer

	mu       sync.Mutex
	requests []*discoveryProto.SignedRequest
	response *discoveryProto.Response
	err      error
}

func (s *captureDiscoveryServer) Discover(_ context.Context, request *discoveryProto.SignedRequest) (*discoveryProto.Response, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, request)
	if s.err != nil {
		return nil, s.err
	}
	return s.response, nil
}

func TestDirectDiscoveryContactsSeedAndParsesPeers(t *testing.T) {
	server := &captureDiscoveryServer{
		response: discoveryPeerMembershipResponse(t, map[string][]string{
			"Org1MSP": []string{"Peer0.Org1.Example.com:7051", "peer1.org1.example.com:8051"},
		}),
	}
	address, stop := startTestDiscoveryServer(t, server)
	defer stop()

	cfg := NewConfig(
		"gateway.example.com:7051",
		testIdentity,
		testSigner{},
		WithDiscoverySeed(address),
	)

	discovered, err := newDirectDiscoveryClient(cfg).Discover(context.Background(), "mychannel")
	if err != nil {
		t.Fatalf("expected discovery success, got %v", err)
	}
	peers := discovered.Peers
	if got, want := len(peers), 2; got != want {
		t.Fatalf("peer count mismatch: got %d want %d", got, want)
	}
	if peers[0].MSPID() != "Org1MSP" || peers[0].URL() != "Peer0.Org1.Example.com:7051" {
		t.Fatalf("first peer mismatch: MSP=%q URL=%q", peers[0].MSPID(), peers[0].URL())
	}
	if got, want := len(discovered.Orderers), 1; got != want {
		t.Fatalf("orderer count mismatch: got %d want %d", got, want)
	}
	if discovered.Orderers[0].MSPID != "OrdererMSP" || discovered.Orderers[0].Endpoint != "orderer.example.com:7050" {
		t.Fatalf("orderer mismatch: %#v", discovered.Orderers[0])
	}

	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.requests) != 1 {
		t.Fatalf("expected one discovery request to seed, got %d", len(server.requests))
	}
	request := server.requests[0]
	payloadDigest := sha256.Sum256(request.GetPayload())
	if !equalBytes(request.GetSignature(), payloadDigest[:]) {
		t.Fatalf("signature mismatch: got %x want %x", request.GetSignature(), payloadDigest)
	}

	decoded := &discoveryProto.Request{}
	if err := proto.Unmarshal(request.GetPayload(), decoded); err != nil {
		t.Fatalf("unmarshal signed discovery payload: %v", err)
	}
	identity := &mspProto.SerializedIdentity{}
	if err := proto.Unmarshal(decoded.GetAuthentication().GetClientIdentity(), identity); err != nil {
		t.Fatalf("unmarshal discovery identity: %v", err)
	}
	if identity.GetMspid() != testIdentity.MSPId {
		t.Fatalf("identity MSP mismatch: got %q want %q", identity.GetMspid(), testIdentity.MSPId)
	}
	if len(decoded.GetQueries()) != 2 || decoded.GetQueries()[0].GetChannel() != "mychannel" || decoded.GetQueries()[0].GetPeerQuery() == nil || decoded.GetQueries()[1].GetConfigQuery() == nil {
		t.Fatalf("unexpected discovery query: %#v", decoded.GetQueries())
	}
}

func TestDirectDiscoveryReportsGRPCFailureAsDiscoveryError(t *testing.T) {
	server := &captureDiscoveryServer{err: status.Error(codes.Unavailable, "seed down")}
	address, stop := startTestDiscoveryServer(t, server)
	defer stop()

	cfg := NewConfig("gateway.example.com:7051", testIdentity, testSigner{}, WithDiscoverySeed(address))
	_, err := newDirectDiscoveryClient(cfg).DiscoverPeers(context.Background(), "mychannel")
	var discoveryErr *DiscoveryError
	if !errors.As(err, &discoveryErr) {
		t.Fatalf("expected DiscoveryError, got %T: %v", err, err)
	}
}

func TestDirectDiscoveryRejectsMalformedResponses(t *testing.T) {
	tests := []struct {
		name     string
		response *discoveryProto.Response
	}{
		{
			name:     "wrong result count",
			response: &discoveryProto.Response{},
		},
		{
			name: "query error",
			response: &discoveryProto.Response{Results: []*discoveryProto.QueryResult{
				{Result: &discoveryProto.QueryResult_Error{Error: &discoveryProto.Error{Content: "access denied"}}},
			}},
		},
		{
			name: "missing membership endpoint",
			response: &discoveryProto.Response{Results: []*discoveryProto.QueryResult{
				{Result: &discoveryProto.QueryResult_Members{Members: &discoveryProto.PeerMembershipResult{
					PeersByOrg: map[string]*discoveryProto.Peers{"Org1MSP": &discoveryProto.Peers{Peers: []*discoveryProto.Peer{{}}}},
				}}},
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := &captureDiscoveryServer{response: tt.response}
			address, stop := startTestDiscoveryServer(t, server)
			defer stop()

			cfg := NewConfig("gateway.example.com:7051", testIdentity, testSigner{}, WithDiscoverySeed(address))
			_, err := newDirectDiscoveryClient(cfg).DiscoverPeers(context.Background(), "mychannel")
			var discoveryErr *DiscoveryError
			if !errors.As(err, &discoveryErr) {
				t.Fatalf("expected DiscoveryError, got %T: %v", err, err)
			}
		})
	}
}

func startTestDiscoveryServer(t *testing.T, server discoveryProto.DiscoveryServer) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	grpcServer := grpc.NewServer()
	discoveryProto.RegisterDiscoveryServer(grpcServer, server)
	go func() {
		_ = grpcServer.Serve(listener)
	}()
	return listener.Addr().String(), func() {
		grpcServer.Stop()
		_ = listener.Close()
	}
}

func discoveryPeerMembershipResponse(t *testing.T, peersByOrg map[string][]string) *discoveryProto.Response {
	t.Helper()
	byOrg := make(map[string]*discoveryProto.Peers, len(peersByOrg))
	for org, endpoints := range peersByOrg {
		for _, endpoint := range endpoints {
			byOrg[org] = &discoveryProto.Peers{Peers: append(byOrg[org].GetPeers(), &discoveryProto.Peer{
				MembershipInfo: discoveryMembershipEnvelope(t, endpoint),
			})}
		}
	}
	return &discoveryProto.Response{Results: []*discoveryProto.QueryResult{
		{Result: &discoveryProto.QueryResult_Members{Members: &discoveryProto.PeerMembershipResult{PeersByOrg: byOrg}}},
		{Result: &discoveryProto.QueryResult_ConfigResult{ConfigResult: discoveryConfigResult(map[string][]string{
			"OrdererMSP": {"orderer.example.com:7050"},
		})}},
	}}
}

func discoveryConfigResult(orderersByOrg map[string][]string) *discoveryProto.ConfigResult {
	orderers := make(map[string]*discoveryProto.Endpoints, len(orderersByOrg))
	for mspID, values := range orderersByOrg {
		for _, value := range values {
			host, portText, _ := strings.Cut(value, ":")
			port, _ := strconv.Atoi(portText)
			orderers[mspID] = &discoveryProto.Endpoints{
				Endpoint: append(orderers[mspID].GetEndpoint(), &discoveryProto.Endpoint{
					Host: host,
					Port: uint32(port),
				}),
			}
		}
	}
	return &discoveryProto.ConfigResult{Orderers: orderers}
}

func discoveryMembershipEnvelope(t *testing.T, endpoint string) *gossipProto.Envelope {
	t.Helper()
	payload, err := proto.Marshal(&gossipProto.GossipMessage{
		Content: &gossipProto.GossipMessage_AliveMsg{
			AliveMsg: &gossipProto.AliveMessage{
				Membership: &gossipProto.Member{Endpoint: endpoint},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal membership gossip message: %v", err)
	}
	return &gossipProto.Envelope{Payload: payload}
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
