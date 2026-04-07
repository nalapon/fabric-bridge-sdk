package fabricbridge

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"sync"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-gateway/pkg/hash"
	gatewayProto "github.com/hyperledger/fabric-protos-go-apiv2/gateway"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	insecureCredentials "google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
)

// Bridge is the main entry point for the SDK.
// By default it connects via fabric-gateway (Gateway gRPC service).
// When setEndorsingPeers is used, it switches to fabric-sdk-go (Endorser gRPC service)
// using a sequential pattern: disconnect gateway → connect peer → execute → disconnect peer → reconnect gateway.
type Bridge struct {
	config          Config
	gatewayClient   *fabricGateway.Gateway
	grpcConnection  *grpc.ClientConn
	connected       bool
	gatewayEndpoint string
	peerConnection  *PeerConnection
	modeMu          sync.RWMutex
}

// Connect establishes a connection to the Fabric network via the Gateway service
func Connect(ctx context.Context, config Config) (*Bridge, error) {
	config = config.normalized()

	if err := config.Validate(); err != nil {
		return nil, &ConfigurationError{Field: "", Message: err.Error()}
	}

	gw, grpcConn, err := connectGateway(config)
	if err != nil {
		return nil, err
	}

	return &Bridge{
		config:          config,
		gatewayClient:   gw,
		grpcConnection:  grpcConn,
		connected:       true,
		gatewayEndpoint: config.GatewayPeer,
	}, nil
}

// connectGateway creates a gRPC connection and connects to the fabric-gateway Gateway service.
// This is extracted so it can be reused by restoreGatewayMode().
func connectGateway(config Config) (*fabricGateway.Gateway, *grpc.ClientConn, error) {
	grpcConn, err := createGRPCConnection(config)
	if err != nil {
		return nil, nil, &ConnectionError{Message: "failed to create gRPC connection", Cause: err}
	}

	id, err := config.IdentityProvider()
	if err != nil {
		grpcConn.Close()
		return nil, nil, &ConnectionError{Message: "failed to create identity", Cause: err}
	}

	gw, err := fabricGateway.Connect(
		id,
		fabricGateway.WithClientConnection(grpcConn),
		fabricGateway.WithSign(adaptSigner(config.Signer)),
		fabricGateway.WithEvaluateTimeout(config.Timeouts.Evaluate),
		fabricGateway.WithEndorseTimeout(config.Timeouts.Endorse),
		fabricGateway.WithSubmitTimeout(config.Timeouts.Submit),
		fabricGateway.WithCommitStatusTimeout(config.Timeouts.Commit),
	)
	if err != nil {
		grpcConn.Close()
		return nil, nil, &ConnectionError{Message: "failed to connect to gateway", Cause: err}
	}

	return gw, grpcConn, nil
}

// Disconnect closes all connections
func (b *Bridge) Disconnect() error {
	b.modeMu.Lock()
	defer b.modeMu.Unlock()

	if !b.connected {
		return nil
	}

	var firstErr error

	if b.peerConnection != nil {
		b.peerConnection.Close()
		b.peerConnection = nil
	}

	if b.gatewayClient != nil {
		if err := b.gatewayClient.Close(); err != nil {
			firstErr = err
		}
	}

	if b.grpcConnection != nil {
		if err := b.grpcConnection.Close(); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		}
	}

	b.connected = false
	return firstErr
}

// IsConnected returns the connection status
func (b *Bridge) IsConnected() bool {
	return b.connected
}

// Network returns a Network for the specified channel.
// The bridge must be connected (in gateway mode) before calling this.
func (b *Bridge) Network(ctx context.Context, channelName string) (*Network, error) {
	b.modeMu.RLock()
	defer b.modeMu.RUnlock()

	if !b.connected {
		return nil, &NotConnectedError{Component: "Bridge", Action: "get network"}
	}

	network := b.gatewayClient.GetNetwork(channelName)
	if network == nil {
		return nil, fmt.Errorf("failed to get network for channel %s", channelName)
	}

	return &Network{
		network: network,
		channel: channelName,
		bridge:  b,
		config:  b.config,
	}, nil
}

// switchToPeerMode disconnects from the Gateway service and connects to peers
// via fabric-sdk-go. channelName is used to build the connection profile.
func (b *Bridge) switchToPeerMode(channelName string) error {
	// Close gateway connection
	if b.gatewayClient != nil {
		b.gatewayClient.Close()
		b.gatewayClient = nil
	}
	if b.grpcConnection != nil {
		b.grpcConnection.Close()
		b.grpcConnection = nil
	}

	// Connect via fabric-sdk-go (direct peer Endorser gRPC)
	pc, err := NewPeerConnection(b.config, channelName)
	if err != nil {
		// Attempt to restore gateway connection on failure
		if gw, grpcConn, gwErr := connectGateway(b.config); gwErr == nil {
			b.gatewayClient = gw
			b.grpcConnection = grpcConn
		}
		return &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}

	b.peerConnection = pc
	return nil
}

// restoreGatewayMode disconnects the peer connection and reconnects to the Gateway service.
// This is called internally after a peer-targeted transaction completes.
func (b *Bridge) restoreGatewayMode() error {
	if b.peerConnection != nil {
		b.peerConnection.Close()
		b.peerConnection = nil
	}

	gw, grpcConn, err := connectGateway(b.config)
	if err != nil {
		return err
	}

	b.gatewayClient = gw
	b.grpcConnection = grpcConn
	return nil
}

// createGRPCConnection creates the gRPC connection with TLS
func createGRPCConnection(config Config) (*grpc.ClientConn, error) {
	transportCredentials := insecureCredentials.NewCredentials()

	if config.TLSOptions != nil && len(config.TLSOptions.TrustedRoots) > 0 {
		certPool, err := createCertPool(config.TLSOptions.TrustedRoots)
		if err != nil {
			return nil, fmt.Errorf("failed to load TLS root certificates: %w", err)
		}

		tlsConfig := &tls.Config{
			RootCAs:            certPool,
			InsecureSkipVerify: config.TLSOptions.AllowInsecureTLS,
			MinVersion:         tls.VersionTLS12,
		}

		if config.TLSOptions.SslTargetNameOverride != "" {
			tlsConfig.ServerName = config.TLSOptions.SslTargetNameOverride
		}

		if len(config.TLSOptions.ClientCert) > 0 && len(config.TLSOptions.ClientKey) > 0 {
			clientCert, err := tls.X509KeyPair(config.TLSOptions.ClientCert, config.TLSOptions.ClientKey)
			if err != nil {
				return nil, fmt.Errorf("failed to load client certificate: %w", err)
			}
			tlsConfig.Certificates = []tls.Certificate{clientCert}
		}

		transportCredentials = credentials.NewTLS(tlsConfig)
	}

	return grpc.NewClient(config.GatewayPeer, grpc.WithTransportCredentials(transportCredentials))
}

func (b *Bridge) commitStatus(ctx context.Context, channelName string, transactionID string) (*CommitStatus, error) {
	b.modeMu.RLock()
	defer b.modeMu.RUnlock()

	if !b.connected || b.grpcConnection == nil {
		return nil, &NotConnectedError{Component: "Bridge", Action: "get commit status"}
	}

	id, err := b.config.IdentityProvider()
	if err != nil {
		return nil, &CommitError{
			Message:       fmt.Sprintf("create identity: %v", err),
			TransactionID: transactionID,
		}
	}

	creator, err := proto.Marshal(&msp.SerializedIdentity{
		Mspid:   id.MspID(),
		IdBytes: id.Credentials(),
	})
	if err != nil {
		return nil, &CommitError{
			Message:       fmt.Sprintf("serialize identity: %v", err),
			TransactionID: transactionID,
		}
	}

	request := &gatewayProto.CommitStatusRequest{
		ChannelId:     channelName,
		TransactionId: transactionID,
		Identity:      creator,
	}
	requestBytes, err := proto.Marshal(request)
	if err != nil {
		return nil, &CommitError{
			Message:       fmt.Sprintf("marshal commit status request: %v", err),
			TransactionID: transactionID,
		}
	}

	signature, err := b.config.Signer.Sign(hash.SHA256(requestBytes))
	if err != nil {
		return nil, &CommitError{
			Message:       fmt.Sprintf("sign commit status request: %v", err),
			TransactionID: transactionID,
		}
	}

	client := gatewayProto.NewGatewayClient(b.grpcConnection)
	response, err := client.CommitStatus(ctx, &gatewayProto.SignedCommitStatusRequest{
		Request:   requestBytes,
		Signature: signature,
	})
	if err != nil {
		return nil, &CommitError{
			Message:       fmt.Sprintf("get status: %v", err),
			TransactionID: transactionID,
		}
	}

	status := &CommitStatus{
		BlockNumber:   response.GetBlockNumber(),
		Status:        response.GetResult(),
		TransactionID: transactionID,
	}

	if response.GetResult() != peer.TxValidationCode_VALID {
		return status, &CommitError{
			Message:       "transaction committed with invalid validation code",
			TransactionID: transactionID,
			Status:        response.GetResult().String(),
		}
	}

	return status, nil
}

// adaptSigner converts our Signer to fabric-gateway Sign function
func adaptSigner(signer Signer) func(digest []byte) ([]byte, error) {
	return signer.Sign
}

// createCertPool creates a certificate pool from PEM-encoded certificates
func createCertPool(pemCerts []byte) (*x509.CertPool, error) {
	certPool := x509.NewCertPool()
	if !certPool.AppendCertsFromPEM(pemCerts) {
		return nil, fmt.Errorf("failed to append certificates from PEM")
	}
	return certPool, nil
}
