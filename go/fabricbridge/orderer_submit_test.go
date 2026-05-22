package fabricbridge

import (
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"sync"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	ordererProto "github.com/hyperledger/fabric-protos-go-apiv2/orderer"
	"google.golang.org/grpc"
)

type captureOrdererServer struct {
	ordererProto.UnimplementedAtomicBroadcastServer

	mu        sync.Mutex
	envelopes []*common.Envelope
	status    common.Status
	info      string
}

func (s *captureOrdererServer) Broadcast(stream grpc.BidiStreamingServer[common.Envelope, ordererProto.BroadcastResponse]) error {
	envelope, err := stream.Recv()
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.envelopes = append(s.envelopes, envelope)
	s.mu.Unlock()
	return stream.Send(&ordererProto.BroadcastResponse{Status: s.status, Info: s.info})
}

func startTestOrdererServer(t *testing.T, status common.Status) (string, *captureOrdererServer, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &captureOrdererServer{status: status}
	grpcServer := grpc.NewServer()
	ordererProto.RegisterAtomicBroadcastServer(grpcServer, server)
	go func() {
		_ = grpcServer.Serve(listener)
	}()
	return listener.Addr().String(), server, func() {
		grpcServer.Stop()
		_ = listener.Close()
	}
}

func TestSubmitEnvelopeToOrdererSendsSignedEnvelope(t *testing.T) {
	address, server, stop := startTestOrdererServer(t, common.Status_SUCCESS)
	defer stop()
	cfg := NewConfig("gateway.example.com:7051", testIdentity, testSigner{}, WithOrderer(address))
	envelope := &common.Envelope{Payload: []byte("payload"), Signature: []byte("signature")}

	if err := submitEnvelopeToOrderer(context.Background(), cfg, envelope, "tx1"); err != nil {
		t.Fatalf("expected orderer submit success, got %v", err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.envelopes) != 1 {
		t.Fatalf("expected one envelope, got %d", len(server.envelopes))
	}
	if string(server.envelopes[0].GetPayload()) != "payload" || string(server.envelopes[0].GetSignature()) != "signature" {
		t.Fatalf("submitted envelope mismatch: %#v", server.envelopes[0])
	}
}

func TestEndorsedTransactionSubmitPeerSignsPayloadWithBridgeIdentity(t *testing.T) {
	address, server, stop := startTestOrdererServer(t, common.Status_SUCCESS)
	defer stop()
	bridge := &Bridge{config: NewConfig("gateway.example.com:7051", testIdentity, testSigner{}, WithOrderer(address)).normalized()}
	tx := &EndorsedTransaction{
		bytes:       []byte("endorsed-payload"),
		result:      []byte("result"),
		txID:        "tx-signed",
		bridge:      bridge,
		channelName: "mychannel",
	}

	submitted, err := tx.submitPeer(context.Background())
	if err != nil {
		t.Fatalf("expected submit success, got %v", err)
	}
	if submitted.TransactionID() != "tx-signed" {
		t.Fatalf("transaction ID mismatch: got %q", submitted.TransactionID())
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.envelopes) != 1 {
		t.Fatalf("expected one envelope, got %d", len(server.envelopes))
	}
	digest := sha256.Sum256([]byte("endorsed-payload"))
	if !equalBytes(server.envelopes[0].GetSignature(), digest[:]) {
		t.Fatalf("signature mismatch: got %x want %x", server.envelopes[0].GetSignature(), digest)
	}
}

func TestSubmitEnvelopeToOrdererRequiresEndpointAndIncludesTransactionIDOnError(t *testing.T) {
	cfg := NewConfig("gateway.example.com:7051", testIdentity, testSigner{})
	err := submitEnvelopeToOrderer(context.Background(), cfg, &common.Envelope{}, "tx-missing")
	var configErr *ConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected ConfigurationError, got %T: %v", err, err)
	}

	address, _, stop := startTestOrdererServer(t, common.Status_BAD_REQUEST)
	defer stop()
	cfg = NewConfig("gateway.example.com:7051", testIdentity, testSigner{}, WithOrderer(address))
	err = submitEnvelopeToOrderer(context.Background(), cfg, &common.Envelope{}, "tx-rejected")
	var submitErr *SubmitError
	if !errors.As(err, &submitErr) {
		t.Fatalf("expected SubmitError, got %T: %v", err, err)
	}
	if submitErr.TransactionID != "tx-rejected" {
		t.Fatalf("transaction ID mismatch: got %q", submitErr.TransactionID)
	}
}
