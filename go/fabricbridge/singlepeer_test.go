package fabricbridge

import (
	"context"
	"errors"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type fakeSinglePeer struct {
	url string
}

func (p fakeSinglePeer) MSPID() string {
	return "Org1MSP"
}

func (p fakeSinglePeer) URL() string {
	return p.url
}

func (p fakeSinglePeer) Properties() fab.Properties {
	return nil
}

func (p fakeSinglePeer) ProcessTransactionProposal(context.Context, fab.ProcessProposalRequest) (*fab.TransactionProposalResponse, error) {
	return nil, nil
}

func TestExecuteSinglePeerTargetsRetriesEligibleFailures(t *testing.T) {
	peers := []fab.Peer{fakeSinglePeer{url: "grpcs://peer0"}, fakeSinglePeer{url: "grpcs://peer1"}}
	var attempted []string

	result, err := executeSinglePeerTargets(
		"evaluate",
		"mychannel",
		"asset",
		"Read",
		nil,
		peers,
		peers,
		true,
		func(peer fab.Peer) (string, error) {
			attempted = append(attempted, peer.URL())
			if len(attempted) == 1 {
				return "", context.DeadlineExceeded
			}
			return "ok", nil
		},
	)
	if err != nil {
		t.Fatalf("expected success after failover, got %v", err)
	}
	if result != "ok" {
		t.Fatalf("expected result ok, got %q", result)
	}
	if got, want := attempted, []string{"grpcs://peer0", "grpcs://peer1"}; !equalStrings(got, want) {
		t.Fatalf("attempted peers mismatch: got %v want %v", got, want)
	}
}

func TestExecuteSinglePeerTargetsStopsOnNonRetryableFailure(t *testing.T) {
	peers := []fab.Peer{fakeSinglePeer{url: "grpcs://peer0"}, fakeSinglePeer{url: "grpcs://peer1"}}
	originalErr := &EvaluationError{Message: "chaincode rejected the query"}
	var attempts int

	_, err := executeSinglePeerTargets(
		"evaluate",
		"mychannel",
		"asset",
		"Read",
		nil,
		peers,
		peers,
		true,
		func(fab.Peer) (string, error) {
			attempts++
			return "", originalErr
		},
	)
	if !errors.Is(err, originalErr) {
		t.Fatalf("expected original error, got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("expected one attempt, got %d", attempts)
	}
}

func TestExecuteSinglePeerTargetsReturnsCanonicalFailureAfterAllEligiblePeersFail(t *testing.T) {
	peers := []fab.Peer{fakeSinglePeer{url: "grpcs://peer0"}, fakeSinglePeer{url: "grpcs://peer1"}}

	_, err := executeSinglePeerTargets(
		"submitAsync",
		"mychannel",
		"asset",
		"Transfer",
		[]string{"peer0", "peer1"},
		peers,
		peers,
		true,
		func(peer fab.Peer) (string, error) {
			if peer.URL() == "grpcs://peer0" {
				return "", context.DeadlineExceeded
			}
			return "", status.Error(codes.Unavailable, "peer unavailable")
		},
	)

	var singlePeerErr *SinglePeerExecutionError
	if !errors.As(err, &singlePeerErr) {
		t.Fatalf("expected SinglePeerExecutionError, got %T: %v", err, err)
	}
	if len(singlePeerErr.Attempts) != 2 {
		t.Fatalf("expected two attempts, got %d", len(singlePeerErr.Attempts))
	}
	if singlePeerErr.Attempts[0].Failover.Category != FailoverTimeout {
		t.Fatalf("expected first attempt timeout, got %s", singlePeerErr.Attempts[0].Failover.Category)
	}
	if singlePeerErr.Attempts[1].Failover.Category != FailoverPeerUnavailable {
		t.Fatalf("expected second attempt peer-unavailable, got %s", singlePeerErr.Attempts[1].Failover.Category)
	}
}

func TestTransactionTargetingRejectsEmptyEndorsingPeers(t *testing.T) {
	_, err := newEndorsingPeersTargeting(nil)
	var configErr *ConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected ConfigurationError, got %T: %v", err, err)
	}
	if configErr.Field != "endorsingPeers" {
		t.Fatalf("expected endorsingPeers field, got %q", configErr.Field)
	}
}

func TestTransactionTargetingRejectsUnsupportedSinglePeerPolicy(t *testing.T) {
	_, err := newSinglePeerTargeting([]SinglePeerOption{
		WithPeerSelectionPolicy(PeerSelectionPolicy("least-loaded")),
	})
	var configErr *ConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected ConfigurationError, got %T: %v", err, err)
	}
	if configErr.Field != "singlePeer.policy" {
		t.Fatalf("expected singlePeer.policy field, got %q", configErr.Field)
	}
}

func TestTransactionTargetingAllowsEmptySinglePeerCandidates(t *testing.T) {
	targeting, err := newSinglePeerTargeting([]SinglePeerOption{WithCandidatePeers()})
	if err != nil {
		t.Fatalf("expected empty candidates to be valid, got %v", err)
	}
	options, ok := targeting.singlePeerOptions()
	if !ok {
		t.Fatal("expected single-peer targeting")
	}
	if len(options.candidates) != 0 {
		t.Fatalf("expected no candidate restriction, got %v", options.candidates)
	}
}

func TestResolveSinglePeerCandidatesRequiresExactEndpoint(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}

	_, err := resolveSinglePeerCandidates(peers, []string{"peer0"})
	var configErr *ConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected ConfigurationError for missing host:port, got %T: %v", err, err)
	}

	resolved, err := resolveSinglePeerCandidates(peers, []string{"peer0.org1.example.com:7051"})
	if err != nil {
		t.Fatalf("expected host:port to resolve, got %v", err)
	}
	if got, want := len(resolved), 1; got != want {
		t.Fatalf("resolved peer count mismatch: got %d want %d", got, want)
	}

	_, err = resolveSinglePeerCandidates(peers, []string{"peer2.org1.example.com:9051"})
	var notFound *PeerNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected PeerNotFoundError for undiscovered endpoint, got %T: %v", err, err)
	}
}

func TestResolveEndorsingPeerTargetsDeduplicatesCanonicalEndpoints(t *testing.T) {
	peers := []fab.Peer{fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"}}

	resolved, err := resolveEndorsingPeerTargets(peers, []string{
		"peer0.org1.example.com:7051",
		"grpcs://peer0.org1.example.com:7051",
	})
	if err != nil {
		t.Fatalf("expected duplicate endpoints to resolve, got %v", err)
	}
	if got, want := len(resolved), 1; got != want {
		t.Fatalf("resolved peer count mismatch: got %d want %d", got, want)
	}
}

func TestBuildGatewayProposalRequiresExplicitProposalCreator(t *testing.T) {
	tx := &Transaction{}

	_, _, err := tx.buildGatewayProposal([]string{"asset1"})
	var configErr *ConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected ConfigurationError, got %T: %v", err, err)
	}
	if configErr.Field != "proposalCreator" {
		t.Fatalf("expected proposalCreator field, got %q", configErr.Field)
	}
}

func TestBuildGatewayProposalUsesExplicitProposalCreator(t *testing.T) {
	tx := &Transaction{
		contract: &Contract{
			chaincodeName: "asset",
			network:       &Network{channel: "mychannel"},
		},
		transactionName: "CreateAsset",
		proposalCreator: &ProposalCreator{
			MSPId:       "ExternalMSP",
			Certificate: []byte("external-cert"),
		},
	}

	proposal, txID, err := tx.buildGatewayProposal([]string{"asset1"})
	if err != nil {
		t.Fatalf("expected proposal, got %v", err)
	}
	if txID == "" {
		t.Fatal("expected transaction ID")
	}

	header := &common.Header{}
	if err := proto.Unmarshal(proposal.GetHeader(), header); err != nil {
		t.Fatalf("unmarshal header: %v", err)
	}
	signatureHeader := &common.SignatureHeader{}
	if err := proto.Unmarshal(header.GetSignatureHeader(), signatureHeader); err != nil {
		t.Fatalf("unmarshal signature header: %v", err)
	}
	creator := &msp.SerializedIdentity{}
	if err := proto.Unmarshal(signatureHeader.GetCreator(), creator); err != nil {
		t.Fatalf("unmarshal creator: %v", err)
	}
	if creator.GetMspid() != "ExternalMSP" {
		t.Fatalf("creator MSP mismatch: got %q", creator.GetMspid())
	}
	if string(creator.GetIdBytes()) != "external-cert" {
		t.Fatalf("creator certificate mismatch: got %q", string(creator.GetIdBytes()))
	}
}

func equalStrings(a, b []string) bool {
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
