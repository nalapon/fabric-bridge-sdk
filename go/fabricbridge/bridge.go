package fabricbridge

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	insecureCredentials "google.golang.org/grpc/credentials/insecure"
)

// Bridge is the main entry point for the SDK
type Bridge struct {
	config          Config
	gatewayClient   *fabricGateway.Gateway
	grpcConnection  *grpc.ClientConn
	connected       bool
	gatewayEndpoint string
	peerConnections map[string]*PeerConnection // channel -> peer connection
}

// Connect establishes a connection to the Fabric network
func Connect(ctx context.Context, config Config) (*Bridge, error) {
	if err := config.Validate(); err != nil {
		return nil, &ConfigurationError{Field: "", Message: err.Error()}
	}

	grpcConn, err := createGRPCConnection(config)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to create gRPC connection", Cause: err}
	}

	id, err := config.IdentityProvider()
	if err != nil {
		grpcConn.Close()
		return nil, &ConnectionError{Message: "failed to create identity", Cause: err}
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
		return nil, &ConnectionError{Message: "failed to connect to gateway", Cause: err}
	}

	return &Bridge{
		config:          config,
		gatewayClient:   gw,
		grpcConnection:  grpcConn,
		connected:       true,
		gatewayEndpoint: config.GatewayPeer,
		peerConnections: make(map[string]*PeerConnection),
	}, nil
}

// Disconnect closes all connections
func (b *Bridge) Disconnect() error {
	if !b.connected {
		return nil
	}

	var firstErr error

	// Close all peer connections
	for _, pc := range b.peerConnections {
		pc.Close()
	}

	if err := b.gatewayClient.Close(); err != nil {
		firstErr = err
	}

	if err := b.grpcConnection.Close(); err != nil {
		if firstErr == nil {
			firstErr = err
		}
	}

	b.connected = false
	return firstErr
}

// IsConnected returns the connection status
func (b *Bridge) IsConnected() bool {
	return b.connected
}

// Network returns a Network for the specified channel
func (b *Bridge) Network(ctx context.Context, channelName string) (*Network, error) {
	if !b.connected {
		return nil, &NotConnectedError{Component: "Bridge", Action: "get network"}
	}

	network := b.gatewayClient.GetNetwork(channelName)
	if network == nil {
		return nil, fmt.Errorf("failed to get network for channel %s", channelName)
	}

	// Initialize peer connection if discovery is enabled
	var peerConn *PeerConnection
	if b.config.Discovery {
		if pc, ok := b.peerConnections[channelName]; ok {
			peerConn = pc
		} else {
			// Create peer connection for this channel
			pc, err := NewPeerConnection(ctx, b.config, channelName)
			if err != nil {
				// Log warning but continue - peer targeting won't work
				peerConn = nil
			} else {
				b.peerConnections[channelName] = pc
				peerConn = pc
			}
		}
	}

	return &Network{
		network:        network,
		channel:        channelName,
		bridge:         b,
		config:         b.config,
		peerConnection: peerConn,
	}, nil
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
			InsecureSkipVerify: !config.TLSOptions.Verify,
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
