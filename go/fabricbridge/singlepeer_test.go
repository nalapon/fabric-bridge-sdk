package fabricbridge

import (
	"context"
	"errors"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	legacychannel "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/client/channel"
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
		peers,
		peers,
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
		peers,
		peers,
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
		peers,
		peers,
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

func TestTransactionTargetingSinglePeerHasNoPeerList(t *testing.T) {
	targeting := newSinglePeerTargeting()
	if !targeting.isSinglePeer() {
		t.Fatal("expected single-peer targeting")
	}
	if got := targeting.endorsingPeerNames(); got != nil {
		t.Fatalf("expected no endorsing peer names, got %v", got)
	}
}

func TestTransactionTargetingLastCallWins(t *testing.T) {
	tx := &Transaction{targeting: gatewayDefaultTransactionTargeting()}
	if err := tx.UseEndorsingPeers("peer0.org1.example.com:7051"); err != nil {
		t.Fatalf("UseEndorsingPeers failed: %v", err)
	}
	if tx.targeting.isSinglePeer() {
		t.Fatal("expected endorsing-peers targeting")
	}
	if err := tx.UseSinglePeer(); err != nil {
		t.Fatalf("UseSinglePeer failed: %v", err)
	}
	if !tx.targeting.isSinglePeer() {
		t.Fatal("expected single-peer targeting after last call")
	}
	if err := tx.UseEndorsingPeers("peer1.org1.example.com:8051"); err != nil {
		t.Fatalf("UseEndorsingPeers failed: %v", err)
	}
	if tx.targeting.isSinglePeer() {
		t.Fatal("expected endorsing-peers targeting after last call")
	}
	if got, want := tx.targeting.endorsingPeerNames(), []string{"peer1.org1.example.com:8051"}; !equalStrings(got, want) {
		t.Fatalf("endorsing peer names mismatch: got %v want %v", got, want)
	}
}

func TestResolveDiscoveredSinglePeersUsesAllDiscoveredPeers(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}

	resolved, err := resolveDiscoveredSinglePeers(peers)
	if err != nil {
		t.Fatalf("expected discovered peers to resolve, got %v", err)
	}
	if got, want := len(resolved), 2; got != want {
		t.Fatalf("resolved peer count mismatch: got %d want %d", got, want)
	}

	_, err = resolveDiscoveredSinglePeers(nil)
	var notFound *PeerNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected PeerNotFoundError for empty discovery, got %T: %v", err, err)
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

func TestEvaluateWithSinglePeerTargetsExactlyOnePeerPerAttempt(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}
	harness := installSinglePeerRuntimeHarness(t, peers)
	harness.queryErrors["grpcs://peer0.org1.example.com:7051"] = context.DeadlineExceeded

	tx := newSinglePeerTestTransaction(t, newSinglePeerTestBridge())
	result, err := tx.Evaluate(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("expected failover success, got %v", err)
	}
	if string(result) != "query:grpcs://peer1.org1.example.com:8051" {
		t.Fatalf("unexpected query result: %q", string(result))
	}
	if got, want := harness.queryAttempts, [][]string{
		{"grpcs://peer0.org1.example.com:7051"},
		{"grpcs://peer1.org1.example.com:8051"},
	}; !equalStringSlices(got, want) {
		t.Fatalf("query attempts mismatch: got %v want %v", got, want)
	}
}

func TestSubmitAsyncWithSinglePeerTargetsExactlyOnePeerPerAttempt(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}
	harness := installSinglePeerRuntimeHarness(t, peers)
	harness.submitErrors["grpcs://peer0.org1.example.com:7051"] = status.Error(codes.Unavailable, "peer unavailable")

	tx := newSinglePeerTestTransaction(t, newSinglePeerTestBridge())
	submitted, err := tx.SubmitAsync(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("expected submit failover success, got %v", err)
	}
	if submitted.TransactionID() != "tx-grpcs://peer1.org1.example.com:8051" {
		t.Fatalf("unexpected transaction ID: %q", submitted.TransactionID())
	}
	if got, want := harness.submitAttempts, [][]string{
		{"grpcs://peer0.org1.example.com:7051"},
		{"grpcs://peer1.org1.example.com:8051"},
	}; !equalStringSlices(got, want) {
		t.Fatalf("submit attempts mismatch: got %v want %v", got, want)
	}
}

func TestSinglePeerRoundRobinIsScopedToBridgeAndPeerSet(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}
	harness := installSinglePeerRuntimeHarness(t, peers)

	bridge := newSinglePeerTestBridge()
	tx1 := newSinglePeerTestTransaction(t, bridge)
	if _, err := tx1.Evaluate(context.Background(), "asset1"); err != nil {
		t.Fatalf("first evaluate failed: %v", err)
	}
	tx2 := newSinglePeerTestTransaction(t, bridge)
	if _, err := tx2.Evaluate(context.Background(), "asset2"); err != nil {
		t.Fatalf("second evaluate failed: %v", err)
	}
	tx3 := newSinglePeerTestTransaction(t, newSinglePeerTestBridge())
	if _, err := tx3.Evaluate(context.Background(), "asset3"); err != nil {
		t.Fatalf("third evaluate failed: %v", err)
	}

	if got, want := harness.queryAttempts, [][]string{
		{"grpcs://peer0.org1.example.com:7051"},
		{"grpcs://peer1.org1.example.com:8051"},
		{"grpcs://peer0.org1.example.com:7051"},
	}; !equalStringSlices(got, want) {
		t.Fatalf("round-robin attempts mismatch: got %v want %v", got, want)
	}
}

func TestEvaluateWithSinglePeerDoesNotFailOverNonRetryableErrors(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}
	harness := installSinglePeerRuntimeHarness(t, peers)
	originalErr := &EvaluationError{Message: "chaincode rejected the query"}
	harness.queryErrors["grpcs://peer0.org1.example.com:7051"] = originalErr

	tx := newSinglePeerTestTransaction(t, newSinglePeerTestBridge())
	_, err := tx.Evaluate(context.Background(), "asset1")
	if !errors.Is(err, originalErr) {
		t.Fatalf("expected original non-retryable error, got %v", err)
	}
	if got, want := harness.queryAttempts, [][]string{{"grpcs://peer0.org1.example.com:7051"}}; !equalStringSlices(got, want) {
		t.Fatalf("query attempts mismatch: got %v want %v", got, want)
	}
}

func TestSubmitWithSinglePeerDoesNotFailOverCommitFailure(t *testing.T) {
	peers := []fab.Peer{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "grpcs://peer1.org1.example.com:8051"},
	}
	harness := installSinglePeerRuntimeHarness(t, peers)
	harness.commitErr = &CommitError{Message: "invalid commit", TransactionID: "tx-grpcs://peer0.org1.example.com:7051"}

	tx := newSinglePeerTestTransaction(t, newSinglePeerTestBridge())
	_, err := tx.Submit(context.Background(), "asset1")
	var commitErr *CommitError
	if !errors.As(err, &commitErr) {
		t.Fatalf("expected CommitError, got %T: %v", err, err)
	}
	if got, want := harness.submitAttempts, [][]string{{"grpcs://peer0.org1.example.com:7051"}}; !equalStringSlices(got, want) {
		t.Fatalf("submit attempts mismatch: got %v want %v", got, want)
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

type singlePeerRuntimeHarness struct {
	peers          []fab.Peer
	queryErrors    map[string]error
	submitErrors   map[string]error
	commitErr      error
	queryAttempts  [][]string
	submitAttempts [][]string
}

type recordingPeerRuntime struct {
	harness *singlePeerRuntimeHarness
}

func installSinglePeerRuntimeHarness(t *testing.T, peers []fab.Peer) *singlePeerRuntimeHarness {
	t.Helper()
	harness := &singlePeerRuntimeHarness{
		peers:        peers,
		queryErrors:  make(map[string]error),
		submitErrors: make(map[string]error),
	}
	previous := newPeerRuntime
	newPeerRuntime = func(Config, string) (peerRuntime, error) {
		return &recordingPeerRuntime{harness: harness}, nil
	}
	t.Cleanup(func() {
		newPeerRuntime = previous
	})
	return harness
}

func (r *recordingPeerRuntime) Close() {}

func (r *recordingPeerRuntime) DiscoverPeers(string) ([]fab.Peer, error) {
	return append([]fab.Peer(nil), r.harness.peers...), nil
}

func (r *recordingPeerRuntime) QueryTargets(_ context.Context, _ string, _ string, _ string, _ [][]byte, peers []fab.Peer, _ map[string][]byte) ([]byte, error) {
	endpoints := peerEndpointsForTest(peers)
	r.harness.queryAttempts = append(r.harness.queryAttempts, endpoints)
	if len(peers) == 0 {
		return nil, errors.New("no peer target")
	}
	if err := r.harness.queryErrors[peers[0].URL()]; err != nil {
		return nil, err
	}
	return []byte("query:" + peers[0].URL()), nil
}

func (r *recordingPeerRuntime) SubmitAsyncTargets(_ context.Context, _ string, _ string, _ string, _ [][]byte, peers []fab.Peer, _ map[string][]byte) (*peerSubmittedTransaction, error) {
	endpoints := peerEndpointsForTest(peers)
	r.harness.submitAttempts = append(r.harness.submitAttempts, endpoints)
	if len(peers) == 0 {
		return nil, errors.New("no peer target")
	}
	if err := r.harness.submitErrors[peers[0].URL()]; err != nil {
		return nil, err
	}
	txID := "tx-" + peers[0].URL()
	return &peerSubmittedTransaction{
		response: &legacychannel.Response{
			TransactionID: fab.TransactionID(txID),
			Payload:       []byte("submit:" + peers[0].URL()),
		},
		waitForCommit: func(context.Context) (*CommitStatus, error) {
			if r.harness.commitErr != nil {
				return nil, r.harness.commitErr
			}
			return &CommitStatus{TransactionID: txID}, nil
		},
	}, nil
}

func newSinglePeerTestBridge() *Bridge {
	return &Bridge{
		config: NewConfig(
			"gateway.example.com:7051",
			testIdentity,
			testSigner{},
			WithOrderer("orderer.example.com:7050"),
		).normalized(),
		roundRobin: newRoundRobinState(),
	}
}

func newSinglePeerTestTransaction(t *testing.T, bridge *Bridge) *Transaction {
	t.Helper()
	tx := (&Contract{
		chaincodeName: "asset",
		network: &Network{
			channel: "mychannel",
			bridge:  bridge,
		},
	}).Transaction("Transfer")
	if err := tx.UseSinglePeer(); err != nil {
		t.Fatalf("UseSinglePeer failed: %v", err)
	}
	return tx
}

func peerEndpointsForTest(peers []fab.Peer) []string {
	out := make([]string, 0, len(peers))
	for _, peer := range peers {
		out = append(out, peer.URL())
	}
	return out
}

func equalStringSlices(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !equalStrings(a[i], b[i]) {
			return false
		}
	}
	return true
}
