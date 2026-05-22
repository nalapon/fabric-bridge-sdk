package fabricbridge

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	legacychannel "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/client/channel"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
	"google.golang.org/protobuf/proto"
)

type fakeExplicitPeer struct {
	url     string
	process func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error)
}

func (p fakeExplicitPeer) MSPID() string {
	return "Org1MSP"
}

func (p fakeExplicitPeer) URL() string {
	return p.url
}

func (p fakeExplicitPeer) Properties() fab.Properties {
	return nil
}

func (p fakeExplicitPeer) ProcessTransactionProposal(ctx context.Context, request fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
	return p.process(ctx, request)
}

func TestEndorseExplicitPeerTargetsRunsConcurrentlyAndPreservesOrder(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	targets := []fab.Peer{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
			started <- "peer0"
			<-release
			return successfulProposalResponse("peer0", []byte("result")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
			started <- "peer1"
			<-release
			return successfulProposalResponse("peer1", []byte("result")), nil
		}},
	}

	var responses []*fab.TransactionProposalResponse
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
	targets := []fab.Peer{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
			return successfulProposalResponse("peer0", []byte("result")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
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
		responses []*fab.TransactionProposalResponse
	}{
		{
			name: "unsuccessful status",
			responses: []*fab.TransactionProposalResponse{
				failedProposalResponse("peer0"),
			},
		},
		{
			name: "missing endorsement",
			responses: []*fab.TransactionProposalResponse{
				proposalResponseWithoutEndorsement("peer0"),
			},
		},
		{
			name: "mismatched payload",
			responses: []*fab.TransactionProposalResponse{
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
	peers := []fab.Peer{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
			return successfulProposalResponse("peer0", []byte("evaluated")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
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
	peers := []fab.Peer{fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
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

func TestSubmitAsyncWithEndorsingPeersPreservesCallerOrderAfterDeduplication(t *testing.T) {
	peers := []fab.Peer{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
			return successfulProposalResponse("peer0", []byte("submitted")), nil
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
			return successfulProposalResponse("peer1", []byte("submitted")), nil
		}},
	}
	harness := installExplicitPeerRuntimeHarness(t, peers)
	tx := newExplicitPeerTestTransaction(t, newSinglePeerTestBridge(), "peer1.org1.example.com:8051", "peer0.org1.example.com:7051", "grpcs://peer1.org1.example.com:8051")

	submitted, err := tx.SubmitAsync(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("expected explicit endorsement submit, got %v", err)
	}
	if submitted.TransactionID() != "explicit-tx" {
		t.Fatalf("transaction ID mismatch: got %q", submitted.TransactionID())
	}
	if got, want := harness.submitAttempts, [][]string{{"grpcs://peer1.org1.example.com:8051", "grpcs://peer0.org1.example.com:7051"}}; !equalStringSlices(got, want) {
		t.Fatalf("submit target order mismatch: got %v want %v", got, want)
	}
}

type explicitPeerRuntimeHarness struct {
	peers          []fab.Peer
	discovered     int
	submitAttempts [][]string
	mu             sync.Mutex
}

type explicitPeerRuntime struct {
	harness *explicitPeerRuntimeHarness
}

func installExplicitPeerRuntimeHarness(t *testing.T, peers []fab.Peer) *explicitPeerRuntimeHarness {
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

func (r *explicitPeerRuntime) DiscoverPeers(string) ([]fab.Peer, error) {
	r.harness.mu.Lock()
	defer r.harness.mu.Unlock()
	r.harness.discovered++
	return append([]fab.Peer(nil), r.harness.peers...), nil
}

func (r *explicitPeerRuntime) QueryTargets(context.Context, string, string, string, [][]byte, []fab.Peer, map[string][]byte) ([]byte, error) {
	return nil, errors.New("QueryTargets should not be used by explicit endorsement")
}

func (r *explicitPeerRuntime) SubmitAsyncTargets(_ context.Context, _ string, _ string, _ string, _ [][]byte, peers []fab.Peer, _ map[string][]byte) (*peerSubmittedTransaction, error) {
	r.harness.mu.Lock()
	r.harness.submitAttempts = append(r.harness.submitAttempts, peerEndpointsForTest(peers))
	r.harness.mu.Unlock()
	return &peerSubmittedTransaction{
		response: &legacychannel.Response{
			TransactionID: fab.TransactionID("explicit-tx"),
			Payload:       []byte("submitted"),
		},
		waitForCommit: func(context.Context) (*CommitStatus, error) {
			return &CommitStatus{TransactionID: "explicit-tx"}, nil
		},
	}, nil
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

func successfulProposalResponse(endorser string, result []byte) *fab.TransactionProposalResponse {
	return &fab.TransactionProposalResponse{
		Endorser: endorser,
		Status:   int32(common.Status_SUCCESS),
		ProposalResponse: &peerProto.ProposalResponse{
			Response:    &peerProto.Response{Status: int32(common.Status_SUCCESS)},
			Payload:     proposalResponsePayload(result),
			Endorsement: &peerProto.Endorsement{Endorser: []byte(endorser), Signature: []byte("signature")},
		},
	}
}

func failedProposalResponse(endorser string) *fab.TransactionProposalResponse {
	return &fab.TransactionProposalResponse{
		Endorser: endorser,
		ProposalResponse: &peerProto.ProposalResponse{
			Response: &peerProto.Response{Status: int32(common.Status_BAD_REQUEST), Message: "bad request"},
			Payload:  proposalResponsePayload([]byte("failed")),
		},
	}
}

func proposalResponseWithoutEndorsement(endorser string) *fab.TransactionProposalResponse {
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

func proposalResponseEndorsers(responses []*fab.TransactionProposalResponse) []string {
	out := make([]string, 0, len(responses))
	for _, response := range responses {
		out = append(out, string(response.ProposalResponse.GetEndorsement().GetEndorser()))
	}
	return out
}
