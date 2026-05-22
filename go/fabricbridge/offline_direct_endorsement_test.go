package fabricbridge

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
)

func TestOfflineSinglePeerSnapshotStoresExactlyOneSelectedPeer(t *testing.T) {
	bridge := newOfflineDirectTestBridge()
	installExplicitPeerRuntimeHarness(t, []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051"},
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051"},
	})
	tx := newOfflineDirectTestTransaction(t, bridge)
	if err := tx.UseSinglePeer(); err != nil {
		t.Fatalf("UseSinglePeer failed: %v", err)
	}

	unsigned, err := tx.NewUnsignedProposal(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("NewUnsignedProposal failed: %v", err)
	}

	request := unsigned.SigningRequest()
	if request.Routing == nil || request.Routing.Mode != "single-peer" {
		t.Fatalf("routing mismatch: %#v", request.Routing)
	}
	if got, want := request.Routing.Peers, []string{"grpcs://peer0.org1.example.com:7051"}; !equalStrings(got, want) {
		t.Fatalf("snapshot peers mismatch: got %v want %v", got, want)
	}
}

func TestOfflineExplicitEndorsementSnapshotStoresDedupedPeersInCallerOrder(t *testing.T) {
	bridge := newOfflineDirectTestBridge()
	installExplicitPeerRuntimeHarness(t, []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051"},
	})
	tx := newOfflineDirectTestTransaction(t, bridge)
	if err := tx.UseEndorsingPeers(
		"peer1.org1.example.com:8051",
		"peer0.org1.example.com:7051",
		"grpcs://peer1.org1.example.com:8051",
	); err != nil {
		t.Fatalf("UseEndorsingPeers failed: %v", err)
	}

	unsigned, err := tx.NewUnsignedProposal(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("NewUnsignedProposal failed: %v", err)
	}

	request := unsigned.SigningRequest()
	if request.Routing == nil || request.Routing.Mode != "endorsing-peers" {
		t.Fatalf("routing mismatch: %#v", request.Routing)
	}
	want := []string{
		"grpcs://peer1.org1.example.com:8051",
		"grpcs://peer0.org1.example.com:7051",
	}
	if got := request.Routing.Peers; !equalStrings(got, want) {
		t.Fatalf("snapshot peers mismatch: got %v want %v", got, want)
	}
}

func TestOfflineSinglePeerEndorsementDoesNotFailOver(t *testing.T) {
	bridge := newOfflineDirectTestBridge()
	unsigned := newSignedOfflineSinglePeerProposal(t, bridge)

	var mu sync.Mutex
	attempts := make(map[string]int)
	installExplicitPeerRuntimeHarness(t, []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			mu.Lock()
			defer mu.Unlock()
			attempts["peer0"]++
			return nil, errors.New("peer0 unavailable")
		}},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			mu.Lock()
			defer mu.Unlock()
			attempts["peer1"]++
			return successfulProposalResponse("peer1", []byte("result")), nil
		}},
	})

	signed, err := bridge.NewSignedProposal(unsigned)
	if err != nil {
		t.Fatalf("NewSignedProposal failed: %v", err)
	}
	_, err = signed.Endorse(context.Background())
	if err == nil {
		t.Fatal("expected snapshotted peer failure")
	}
	if got := attempts["peer0"]; got != 1 {
		t.Fatalf("expected one peer0 attempt, got %d", got)
	}
	if got := attempts["peer1"]; got != 0 {
		t.Fatalf("expected no peer1 failover attempt, got %d", got)
	}
}

func TestOfflineResumeRevalidatesSnapshotPeersAgainstCurrentDiscovery(t *testing.T) {
	bridge := newOfflineDirectTestBridge()
	unsigned := newSignedOfflineSinglePeerProposal(t, bridge)
	installExplicitPeerRuntimeHarness(t, []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051", process: func(context.Context, processProposalRequest) (*proposalResponse, error) {
			return successfulProposalResponse("peer1", []byte("result")), nil
		}},
	})

	signed, err := bridge.NewSignedProposal(unsigned)
	if err != nil {
		t.Fatalf("NewSignedProposal failed: %v", err)
	}
	_, err = signed.Endorse(context.Background())
	var endorsementErr *EndorsementError
	if !errors.As(err, &endorsementErr) {
		t.Fatalf("expected EndorsementError, got %T: %v", err, err)
	}
	if !strings.Contains(endorsementErr.Message, "peer grpcs://peer0.org1.example.com:7051 not found") {
		t.Fatalf("missing peer message mismatch: %q", endorsementErr.Message)
	}
}

func TestOfflineExplicitEndorsementRunsConcurrently(t *testing.T) {
	bridge := newOfflineDirectTestBridge()
	installExplicitPeerRuntimeHarness(t, []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051"},
	})
	tx := newOfflineDirectTestTransaction(t, bridge)
	if err := tx.UseEndorsingPeers("peer0.org1.example.com:7051", "peer1.org1.example.com:8051"); err != nil {
		t.Fatalf("UseEndorsingPeers failed: %v", err)
	}
	unsigned, err := tx.NewUnsignedProposal(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("NewUnsignedProposal failed: %v", err)
	}

	started := make(chan string, 2)
	release := make(chan struct{})
	installExplicitPeerRuntimeHarness(t, []peerTarget{
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
	})

	signed, err := bridge.NewSignedProposal(signOfflineProposal(t, unsigned))
	if err != nil {
		t.Fatalf("NewSignedProposal failed: %v", err)
	}

	var endorsed *EndorsedTransaction
	var endorseErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		endorsed, endorseErr = signed.Endorse(context.Background())
	}()

	seen := map[string]bool{<-started: true, <-started: true}
	if !seen["peer0"] || !seen["peer1"] {
		t.Fatalf("expected both peers to start concurrently, got %v", seen)
	}
	close(release)
	<-done

	if endorseErr != nil {
		t.Fatalf("Endorse failed: %v", endorseErr)
	}
	if endorsed.TransactionID() == "" {
		t.Fatal("expected endorsed direct transaction ID")
	}
}

func TestOfflineDirectEndorsementSubmitUsesOrdererSubmit(t *testing.T) {
	ordererAddress, ordererServer, stopOrderer := startTestOrdererServer(t, common.Status_SUCCESS)
	defer stopOrderer()
	gatewayAddress, _, stopGateway := startTestGatewayCommitStatusServer(t, peerProto.TxValidationCode_VALID)
	defer stopGateway()

	bridge := newBridgeWithGatewayCommitStatus(t, gatewayAddress, ordererAddress)
	tx := &EndorsedTransaction{
		bytes:       []byte("endorsed-payload"),
		result:      []byte("result"),
		txID:        "tx-offline-direct",
		bridge:      bridge,
		channelName: "mychannel",
	}

	submitted, err := tx.SubmitAsync(context.Background())
	if err != nil {
		t.Fatalf("SubmitAsync failed: %v", err)
	}
	if submitted.TransactionID() != "tx-offline-direct" {
		t.Fatalf("transaction ID mismatch: %q", submitted.TransactionID())
	}
	if len(ordererServer.envelopes) != 1 {
		t.Fatalf("expected one orderer envelope, got %d", len(ordererServer.envelopes))
	}
}

func newOfflineDirectTestBridge() *Bridge {
	return &Bridge{
		config: NewConfig(
			"gateway.example.com:7051",
			testIdentity,
			testSigner{},
			WithOrderer("orderer.example.com:7050"),
		).normalized(),
		connected:  true,
		roundRobin: newRoundRobinState(),
	}
}

func newOfflineDirectTestTransaction(t *testing.T, bridge *Bridge) *Transaction {
	t.Helper()
	return (&Contract{
		chaincodeName: "asset",
		network: &Network{
			channel: "mychannel",
			bridge:  bridge,
		},
	}).Transaction("Transfer").SetProposalCreator(ProposalCreator{
		MSPId:       testIdentity.MSPId,
		Certificate: testIdentity.Certificate,
	})
}

func newSignedOfflineSinglePeerProposal(t *testing.T, bridge *Bridge) SignedMessage {
	t.Helper()
	installExplicitPeerRuntimeHarness(t, []peerTarget{
		fakeExplicitPeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeExplicitPeer{url: "grpcs://peer1.org1.example.com:8051"},
	})
	tx := newOfflineDirectTestTransaction(t, bridge)
	if err := tx.UseSinglePeer(); err != nil {
		t.Fatalf("UseSinglePeer failed: %v", err)
	}
	unsigned, err := tx.NewUnsignedProposal(context.Background(), "asset1")
	if err != nil {
		t.Fatalf("NewUnsignedProposal failed: %v", err)
	}
	return signOfflineProposal(t, unsigned)
}

func signOfflineProposal(t *testing.T, unsigned *UnsignedProposal) SignedMessage {
	t.Helper()
	signature, err := testSigner{}.Sign(unsigned.Digest())
	if err != nil {
		t.Fatalf("sign proposal: %v", err)
	}
	return unsigned.WithSignature(signature)
}
