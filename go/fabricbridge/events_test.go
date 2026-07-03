package fabricbridge

import (
	"errors"
	"io"
	"testing"

	gatewayProto "github.com/hyperledger/fabric-protos-go-apiv2/gateway"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
)

func TestChaincodeEventStreamRecvReturnsAllEventsBeforeNextResponse(t *testing.T) {
	stream := &ChaincodeEventStream{
		stream: &fakeChaincodeEventsReceiver{
			responses: []*gatewayProto.ChaincodeEventsResponse{
				{
					BlockNumber: 12,
					Events: []*peerProto.ChaincodeEvent{
						{TxId: "tx1", ChaincodeId: "fsblock", EventName: "file", Payload: []byte("one")},
						{TxId: "tx2", ChaincodeId: "fsblock", EventName: "file", Payload: []byte("two")},
					},
				},
			},
			err: io.EOF,
		},
	}

	first, err := stream.Recv()
	if err != nil {
		t.Fatalf("first Recv failed: %v", err)
	}
	if first.TransactionID != "tx1" || string(first.Payload) != "one" {
		t.Fatalf("unexpected first event: %#v", first)
	}

	second, err := stream.Recv()
	if err != nil {
		t.Fatalf("second Recv failed: %v", err)
	}
	if second.TransactionID != "tx2" || string(second.Payload) != "two" {
		t.Fatalf("unexpected second event: %#v", second)
	}

	if _, err := stream.Recv(); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF, got %v", err)
	}
}

type fakeChaincodeEventsReceiver struct {
	responses []*gatewayProto.ChaincodeEventsResponse
	err       error
}

func (r *fakeChaincodeEventsReceiver) Recv() (*gatewayProto.ChaincodeEventsResponse, error) {
	if len(r.responses) == 0 {
		return nil, r.err
	}

	response := r.responses[0]
	r.responses = r.responses[1:]
	return response, nil
}
