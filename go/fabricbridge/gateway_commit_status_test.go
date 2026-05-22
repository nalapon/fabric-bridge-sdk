package fabricbridge

import (
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"sync"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	gatewayProto "github.com/hyperledger/fabric-protos-go-apiv2/gateway"
	mspProto "github.com/hyperledger/fabric-protos-go-apiv2/msp"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
)

type captureGatewayCommitStatusServer struct {
	gatewayProto.UnimplementedGatewayServer

	mu       sync.Mutex
	requests []*gatewayProto.SignedCommitStatusRequest
	result   peerProto.TxValidationCode
	block    uint64
}

func (s *captureGatewayCommitStatusServer) CommitStatus(_ context.Context, request *gatewayProto.SignedCommitStatusRequest) (*gatewayProto.CommitStatusResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, request)
	return &gatewayProto.CommitStatusResponse{Result: s.result, BlockNumber: s.block}, nil
}

func TestDirectSubmittedTransactionWaitUsesGatewayCommitStatus(t *testing.T) {
	ordererAddress, _, stopOrderer := startTestOrdererServer(t, common.Status_SUCCESS)
	defer stopOrderer()
	gatewayAddress, gatewayServer, stopGateway := startTestGatewayCommitStatusServer(t, peerProto.TxValidationCode_VALID)
	defer stopGateway()

	bridge := newBridgeWithGatewayCommitStatus(t, gatewayAddress, ordererAddress)
	tx := &EndorsedTransaction{
		bytes:       []byte("endorsed-payload"),
		result:      []byte("result"),
		txID:        "tx-direct",
		bridge:      bridge,
		channelName: "mychannel",
	}

	submitted, err := tx.submitPeer(context.Background())
	if err != nil {
		t.Fatalf("submitPeer failed: %v", err)
	}
	status, err := submitted.WaitForCommit(context.Background())
	if err != nil {
		t.Fatalf("WaitForCommit failed: %v", err)
	}
	if status.TransactionID != "tx-direct" || status.Status != peerProto.TxValidationCode_VALID || status.BlockNumber != 42 {
		t.Fatalf("commit status mismatch: %#v", status)
	}
	if got, want := len(gatewayServer.requests), 1; got != want {
		t.Fatalf("gateway commit status requests mismatch: got %d want %d", got, want)
	}
}

func TestGatewayCommitStatusRequestIsSignedWithBridgeIdentity(t *testing.T) {
	gatewayAddress, gatewayServer, stopGateway := startTestGatewayCommitStatusServer(t, peerProto.TxValidationCode_VALID)
	defer stopGateway()
	bridge := newBridgeWithGatewayCommitStatus(t, gatewayAddress, "")

	_, err := bridge.commitStatus(context.Background(), "mychannel", "tx-signed")
	if err != nil {
		t.Fatalf("commitStatus failed: %v", err)
	}

	gatewayServer.mu.Lock()
	defer gatewayServer.mu.Unlock()
	if len(gatewayServer.requests) != 1 {
		t.Fatalf("expected one request, got %d", len(gatewayServer.requests))
	}
	signed := gatewayServer.requests[0]
	digest := sha256.Sum256(signed.GetRequest())
	if !equalBytes(signed.GetSignature(), digest[:]) {
		t.Fatalf("signature mismatch: got %x want %x", signed.GetSignature(), digest)
	}

	request := &gatewayProto.CommitStatusRequest{}
	if err := proto.Unmarshal(signed.GetRequest(), request); err != nil {
		t.Fatalf("unmarshal commit status request: %v", err)
	}
	if request.GetChannelId() != "mychannel" || request.GetTransactionId() != "tx-signed" {
		t.Fatalf("request routing mismatch: %#v", request)
	}
	identity := &mspProto.SerializedIdentity{}
	if err := proto.Unmarshal(request.GetIdentity(), identity); err != nil {
		t.Fatalf("unmarshal identity: %v", err)
	}
	provider, err := bridge.config.IdentityProvider()
	if err != nil {
		t.Fatalf("create identity provider: %v", err)
	}
	if identity.GetMspid() != provider.MspID() || !equalBytes(identity.GetIdBytes(), provider.Credentials()) {
		t.Fatalf("identity mismatch: %#v", identity)
	}
}

func TestGatewayCommitStatusInvalidValidationCodeReturnsCommitErrorWithStatus(t *testing.T) {
	gatewayAddress, _, stopGateway := startTestGatewayCommitStatusServer(t, peerProto.TxValidationCode_MVCC_READ_CONFLICT)
	defer stopGateway()
	bridge := newBridgeWithGatewayCommitStatus(t, gatewayAddress, "")

	status, err := bridge.commitStatus(context.Background(), "mychannel", "tx-invalid")
	var commitErr *CommitError
	if !errors.As(err, &commitErr) {
		t.Fatalf("expected CommitError, got %T: %v", err, err)
	}
	if status == nil || status.Status != peerProto.TxValidationCode_MVCC_READ_CONFLICT {
		t.Fatalf("status mismatch: %#v", status)
	}
	if commitErr.TransactionID != "tx-invalid" || commitErr.Status != peerProto.TxValidationCode_MVCC_READ_CONFLICT.String() {
		t.Fatalf("commit error mismatch: %#v", commitErr)
	}
}

func startTestGatewayCommitStatusServer(t *testing.T, result peerProto.TxValidationCode) (string, *captureGatewayCommitStatusServer, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &captureGatewayCommitStatusServer{result: result, block: 42}
	grpcServer := grpc.NewServer()
	gatewayProto.RegisterGatewayServer(grpcServer, server)
	go func() {
		_ = grpcServer.Serve(listener)
	}()
	return listener.Addr().String(), server, func() {
		grpcServer.Stop()
		_ = listener.Close()
	}
}

func newBridgeWithGatewayCommitStatus(t *testing.T, gatewayAddress string, ordererAddress string) *Bridge {
	t.Helper()
	config := NewConfig("gateway.example.com:7051", testIdentity, testSigner{})
	if ordererAddress != "" {
		config = NewConfig("gateway.example.com:7051", testIdentity, testSigner{}, WithOrderer(ordererAddress))
	}
	conn, err := grpc.NewClient(gatewayAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("connect gateway test server: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return &Bridge{
		config:         config.normalized(),
		grpcConnection: conn,
		connected:      true,
		roundRobin:     newRoundRobinState(),
	}
}
