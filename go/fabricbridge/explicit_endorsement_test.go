package fabricbridge

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
)

type fakeExplicitPeer struct {
	url     string
	process func(context.Context, processProposalRequest) (*proposalResponse, error)
}

func (p fakeExplicitPeer) MSPID() string {
	return "Org1MSP"
}

func (p fakeExplicitPeer) URL() string {
	return p.url
}

func (p fakeExplicitPeer) Properties() peerProperties {
	return nil
}

func (p fakeExplicitPeer) ProcessTransactionProposal(ctx context.Context, request processProposalRequest) (*proposalResponse, error) {
	return p.process(ctx, request)
}

func TestEndorseExplicitPeerTargetsRunsConcurrentlyAndPreservesOrder(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	targets := []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			started <- "peer0"
			<-release
			return successfulProposalResponse("peer0", []byte("result")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			started <- "peer1"
			<-release
			return successfulProposalResponse("peer1", []byte("result")), nil
		}},
	}

	var responses []*proposalResponse
	var err error
	done := make(chan struct{})
	go func() {
		defer close(done)
		responses, err = endorseExplicitPeerTargets(context.Background(), &peerProto.Proposal{}, testSigner{}, targets)
	}()

	seen := map[string]bool{<-started: true, <-started: true}
	if !seen["peer0"] || !seen["peer1"] {
		t.Fatalf("expected both peers to start concurrently, got %v", seen)
	}
	close(release)
	<-done

	if err != nil {
		t.Fatalf("expected endorsements, got %v", err)
	}
	if got, want := proposalResponseEndorsers(responses), []string{"peer0", "peer1"}; !equalStrings(got, want) {
		t.Fatalf("response order mismatch: got %v want %v", got, want)
	}
}

func TestEndorseExplicitPeerTargetsFailsOnAnySelectedPeerFailure(t *testing.T) {
	targets := []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return successfulProposalResponse("peer0", []byte("result")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return nil, errors.New("endorser refused")
		}},
	}

	_, err := endorseExplicitPeerTargets(context.Background(), &peerProto.Proposal{}, testSigner{}, targets)
	var endorsementErr *EndorsementError
	if !errors.As(err, &endorsementErr) {
		t.Fatalf("expected EndorsementError, got %T: %v", err, err)
	}
	if endorsementErr.Message == "" {
		t.Fatal("expected endorsement failure message")
	}
}

func TestEndorseExplicitPeerTargetsValidatesSuccessfulMatchingEndorsements(t *testing.T) {
	tests := []struct {
		name      string
		responses []*proposalResponse
	}{
		{
			name: "unsuccessful status",
			responses: []*proposalResponse{
				failedProposalResponse("peer0"),
			},
		},
		{
			name: "missing endorsement",
			responses: []*proposalResponse{
				proposalResponseWithoutEndorsement("peer0"),
			},
		},
		{
			name: "mismatched payload",
			responses: []*proposalResponse{
				successfulProposalResponse("peer0", []byte("result-a")),
				successfulProposalResponse("peer1", []byte("result-b")),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validatePeerProposalResponses(tt.responses); err == nil {
				t.Fatal("expected validation failure")
			}
		})
	}
}

func TestEvaluateWithEndorsingPeersResolvesAllPeersAndPreservesCallerOrder(t *testing.T) {
	peers := []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return successfulProposalResponse("peer0", []byte("evaluated")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return successfulProposalResponse("peer1", []byte("evaluated")), nil
		}},
	}
	harness := installExplicitPeerRuntimeHarness(t, peers)
	tx := newExplicitPeerTestTransaction(t, newSinglePeerTestBridge(), "peer1.org1.example.com:8051", "peer0.org1.example.com:7051", "grpcs://peer1.org1.example.com:8051")

	result, err := tx.Evaluate(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("expected explicit endorsement evaluation, got %v", err)
	}
	if string(result) != "evaluated" {
		t.Fatalf("evaluation result mismatch: got %q", string(result))
	}
	if got, want := harness.discovered, 1; got != want {
		t.Fatalf("discovery count mismatch: got %d want %d", got, want)
	}
}

func TestEvaluateWithEndorsingPeersFailsWhenRequestedPeerMissing(t *testing.T) {
	peers := []peerTarget{fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
		return successfulProposalResponse("peer0", []byte("evaluated")), nil
	}}}
	installExplicitPeerRuntimeHarness(t, peers)
	tx := newExplicitPeerTestTransaction(t, newSinglePeerTestBridge(), "peer1.org1.example.com:8051")

	_, err := tx.Evaluate(context.Background(), "asset1")
	var notFound *PeerNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected PeerNotFoundError, got %T: %v", err, err)
	}
}

func TestSubmitAsyncWithEndorsingPeersRequiresOrdererEndpointLocally(t *testing.T) {
	tx := newExplicitPeerTestTransaction(t, newSinglePeerTestBridgeWithoutOrderer(), "peer0.org1.example.com:7051")
	_, err := tx.SubmitAsync(context.Background(), "asset1")
	var configErr *ConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected ConfigurationError, got %T: %v", err, err)
	}
	if configErr.Field != "ordererEndpoint" {
		t.Fatalf("expected ordererEndpoint field, got %q", configErr.Field)
	}
}

func TestSubmitAsyncWithEndorsingPeersPreservesCallerOrderAfterDeduplication(t *testing.T) {
	ordererAddress, _, stop := startTestOrdererServer(t, common.Status_SUCCESS)
	defer stop()
	peers := []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return successfulProposalResponse("peer0", []byte("submitted")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return successfulProposalResponse("peer1", []byte("submitted")), nil
		}},
	}
	installExplicitPeerRuntimeHarness(t, peers)
	tx := newExplicitPeerTestTransaction(t, newSinglePeerTestBridgeWithOrderer(ordererAddress), "peer1.org1.example.com:8051", "peer0.org1.example.com:7051", "grpcs://peer1.org1.example.com:8051")

	submitted, err := tx.SubmitAsync(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("expected explicit endorsement submit, got %v", err)
	}
	if submitted.TransactionID() == "" {
		t.Fatal("expected non-empty direct transaction ID")
	}
}

func TestResolveEndorsingPeerTargetsPreservesCallerOrderAfterDeduplication(t *testing.T) {
	discovered := []peerTarget{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}
	targets, err := resolveEndorsingPeerTargets(discovered, []string{
		"peer1.org1.example.com:8051",
		"peer0.org1.example.com:7051",
		"grpcs://peer1.org1.example.com:8051",
	})
	if err != nil {
		t.Fatalf("resolve targets: %v", err)
	}
	if got, want := peerEndpointsForTest(targets), []string{"grpcs://peer1.org1.example.com:8051", "grpcs://peer0.org1.example.com:7051"}; !equalStrings(got, want) {
		t.Fatalf("target order mismatch: got %v want %v", got, want)
	}
}

type explicitPeerRuntimeHarness struct {
	peers      []peerTarget
	discovered int
	mu         sync.Mutex
}

type explicitPeerRuntime struct {
	harness *explicitPeerRuntimeHarness
}

func installExplicitPeerRuntimeHarness(t *testing.T, peers []peerTarget) *explicitPeerRuntimeHarness {
	t.Helper()
	harness := &explicitPeerRuntimeHarness{peers: peers}
	previous := newPeerRuntime
	newPeerRuntime = func(Config, string) (peerRuntime, error) {
		return &explicitPeerRuntime{harness: harness}, nil
	}
	t.Cleanup(func() {
		newPeerRuntime = previous
	})
	return harness
}

func (r *explicitPeerRuntime) Close() {}

func (r *explicitPeerRuntime) DiscoverPeers(string) ([]peerTarget, error) {
	r.harness.mu.Lock()
	defer r.harness.mu.Unlock()
	r.harness.discovered++
	return append([]peerTarget(nil), r.harness.peers...), nil
}

func (r *explicitPeerRuntime) QueryTargets(context.Context, string, string, string, [][]byte, []peerTarget, map[string][]byte) ([]byte, error) {
	return nil, errors.New("QueryTargets should not be used by explicit endorsement")
}

func newExplicitPeerTestTransaction(t *testing.T, bridge *Bridge, peers ...string) *Transaction {
	t.Helper()
	tx := (&Contract{
		chaincodeName: "asset",
		network: &Network{
			channel: "mychannel",
			bridge:  bridge,
		},
	}).Transaction("Read")
	if err := tx.UseEndorsingPeers(peers...); err != nil {
		t.Fatalf("UseEndorsingPeers failed: %v", err)
	}
	return tx
}

func successfulProposalResponse(endorser string, result []byte) *proposalResponse {
	return &proposalResponse{
		Endorser: endorser,
		Status:   int32(common.Status_SUCCESS),
		ProposalResponse: &peerProto.ProposalResponse{
			Response:    &peerProto.Response{Status: int32(common.Status_SUCCESS)},
			Payload:     proposalResponsePayload(result),
			Endorsement: &peerProto.Endorsement{Endorser: []byte(endorser), Signature: []byte("signature")},
		},
	}
}

func failedProposalResponse(endorser string) *proposalResponse {
	return &proposalResponse{
		Endorser: endorser,
		ProposalResponse: &peerProto.ProposalResponse{
			Response: &peerProto.Response{Status: int32(common.Status_BAD_REQUEST), Message: "bad request"},
			Payload:  proposalResponsePayload([]byte("failed")),
		},
	}
}

func proposalResponseWithoutEndorsement(endorser string) *proposalResponse {
	response := successfulProposalResponse(endorser, []byte("result"))
	response.ProposalResponse.Endorsement = nil
	return response
}

func proposalResponsePayload(result []byte) []byte {
	actionBytes, err := proto.Marshal(&peerProto.ChaincodeAction{
		Response: &peerProto.Response{Status: int32(common.Status_SUCCESS), Payload: result},
	})
	if err != nil {
		panic(err)
	}
	payloadBytes, err := proto.Marshal(&peerProto.ProposalResponsePayload{Extension: actionBytes})
	if err != nil {
		panic(err)
	}
	return payloadBytes
}

func proposalResponseEndorsers(responses []*proposalResponse) []string {
	out := make([]string, 0, len(responses))
	for _, response := range responses {
		out = append(out, string(response.ProposalResponse.GetEndorsement().GetEndorser()))
	}
	return out
}
