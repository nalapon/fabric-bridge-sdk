package fabricbridge

import (
	"context"
	"fmt"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	ordererProto "github.com/hyperledger/fabric-protos-go-apiv2/orderer"
)

func submitEnvelopeToOrderer(ctx context.Context, cfg Config, envelope *common.Envelope, txID string, discoveredOrdererEndpoint ...string) error {
	cfg = cfg.normalized()
	ordererEndpoint := cfg.OrdererEndpoint
	if ordererEndpoint == "" && len(discoveredOrdererEndpoint) > 0 {
		ordererEndpoint = discoveredOrdererEndpoint[0]
	}
	if ordererEndpoint == "" {
		return &ConfigurationError{
			Field:   "ordererEndpoint",
			Message: "ordererEndpoint is required for direct endorsement submit when discovery returns no orderer endpoints",
		}
	}

	if timeout := cfg.Timeouts.Submit; timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	conn, err := createGRPCConnectionTo(ordererEndpoint, cfg.OrdererTLS)
	if err != nil {
		return &SubmitError{Message: fmt.Sprintf("connect orderer: %v", err), TransactionID: txID}
	}
	defer conn.Close()

	stream, err := ordererProto.NewAtomicBroadcastClient(conn).Broadcast(ctx)
	if err != nil {
		return &SubmitError{Message: fmt.Sprintf("open orderer broadcast: %v", err), TransactionID: txID}
	}
	if err := stream.Send(envelope); err != nil {
		_ = stream.CloseSend()
		return &SubmitError{Message: fmt.Sprintf("send orderer envelope: %v", err), TransactionID: txID}
	}
	response, err := stream.Recv()
	_ = stream.CloseSend()
	if err != nil {
		return &SubmitError{Message: fmt.Sprintf("receive orderer response: %v", err), TransactionID: txID}
	}
	if response.GetStatus() != common.Status_SUCCESS {
		return &SubmitError{
			Message:       fmt.Sprintf("orderer rejected transaction: status=%s info=%s", response.GetStatus(), response.GetInfo()),
			TransactionID: txID,
		}
	}
	return nil
}
