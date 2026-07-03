package fabricbridge

import (
	"context"
	"fmt"
	"io"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	gatewayProto "github.com/hyperledger/fabric-protos-go-apiv2/gateway"
	"google.golang.org/protobuf/proto"
)

// ChaincodeEvent is emitted by a transaction function.
type ChaincodeEvent = fabricGateway.ChaincodeEvent

// Checkpoint provides the current position for event processing.
type Checkpoint = fabricGateway.Checkpoint

// Checkpointer stores event processing progress.
type Checkpointer interface {
	Checkpoint
	CheckpointBlock(blockNumber uint64) error
	CheckpointTransaction(blockNumber uint64, transactionID string) error
	CheckpointChaincodeEvent(event *ChaincodeEvent) error
}

// ChaincodeEventsOption configures chaincode event listening.
type ChaincodeEventsOption = fabricGateway.ChaincodeEventsOption

// WithStartBlock reads events starting at the specified block number.
func WithStartBlock(blockNumber uint64) ChaincodeEventsOption {
	return fabricGateway.WithStartBlock(blockNumber)
}

// WithCheckpoint resumes events from the checkpoint position.
func WithCheckpoint(checkpoint Checkpoint) ChaincodeEventsOption {
	return fabricGateway.WithCheckpoint(checkpoint)
}

// ChaincodeEventStream receives chaincode events and exposes stream errors.
type ChaincodeEventStream struct {
	stream  chaincodeEventsReceiver
	pending []*ChaincodeEvent
}

type chaincodeEventsReceiver interface {
	Recv() (*gatewayProto.ChaincodeEventsResponse, error)
}

// ChaincodeEvents opens a stream of events emitted by the named chaincode.
func (n *Network) ChaincodeEvents(ctx context.Context, chaincodeName string, opts ...ChaincodeEventsOption) (*ChaincodeEventStream, error) {
	n.bridge.modeMu.RLock()
	defer n.bridge.modeMu.RUnlock()

	if !n.bridge.connected || n.bridge.grpcConnection == nil {
		return nil, &NotConnectedError{Component: "Network", Action: "listen for chaincode events"}
	}

	request, err := n.network.NewChaincodeEventsRequest(chaincodeName, opts...)
	if err != nil {
		return nil, err
	}

	signature, err := n.config.Signer.Sign(request.Digest())
	if err != nil {
		return nil, fmt.Errorf("sign chaincode events request: %w", err)
	}

	requestBytes, err := request.Bytes()
	if err != nil {
		return nil, err
	}

	signedRequest := &gatewayProto.SignedChaincodeEventsRequest{}
	if err := proto.Unmarshal(requestBytes, signedRequest); err != nil {
		return nil, fmt.Errorf("decode chaincode events request: %w", err)
	}
	signedRequest.Signature = signature

	stream, err := gatewayProto.NewGatewayClient(n.bridge.grpcConnection).ChaincodeEvents(ctx, signedRequest)
	if err != nil {
		return nil, err
	}

	return &ChaincodeEventStream{stream: stream}, nil
}

// Recv returns the next chaincode event. It returns io.EOF when the stream ends normally.
func (s *ChaincodeEventStream) Recv() (*ChaincodeEvent, error) {
	for {
		if len(s.pending) > 0 {
			event := s.pending[0]
			s.pending = s.pending[1:]
			return event, nil
		}

		response, err := s.stream.Recv()
		if err != nil {
			if err == io.EOF {
				return nil, io.EOF
			}
			return nil, err
		}

		for _, event := range response.GetEvents() {
			s.pending = append(s.pending, &ChaincodeEvent{
				BlockNumber:   response.GetBlockNumber(),
				TransactionID: event.GetTxId(),
				ChaincodeName: event.GetChaincodeId(),
				EventName:     event.GetEventName(),
				Payload:       event.GetPayload(),
			})
		}
	}
}
