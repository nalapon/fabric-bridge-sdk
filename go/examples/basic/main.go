package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/kolokium/fabric-bridge-go/fabricbridge"
)

// SimpleSigner implements the Signer interface
type SimpleSigner struct {
	privateKey []byte
}

func (s *SimpleSigner) Sign(message []byte) ([]byte, error) {
	// In production, use proper crypto signing
	return message, nil
}

func main() {
	ctx := context.Background()

	// Create signer
	signer := &SimpleSigner{privateKey: []byte("dummy-key")}

	// Create config for gateway mode
	config := fabricbridge.NewConfig(
		"localhost:7051",
		fabricbridge.Identity{
			MSPId:       "Org1MSP",
			Certificate: []byte("-----BEGIN CERTIFICATE-----\ndummy-cert\n-----END CERTIFICATE-----"),
			PrivateKey:  []byte("-----BEGIN PRIVATE KEY-----\ndummy-key\n-----END PRIVATE KEY-----"),
		},
		signer,
		fabricbridge.WithDiscovery(true),
		fabricbridge.WithTimeout(fabricbridge.TimeoutConfig{
			Endorse:  30 * time.Second,
			Submit:   30 * time.Second,
			Commit:   60 * time.Second,
			Evaluate: 30 * time.Second,
		}),
		// Optional: TLS config
		// fabricbridge.WithTLS(fabricbridge.TLSOptions{
		// 	TrustedRoots:        tlsRootCert,
		// 	Verify:              true,
		// 	SslTargetNameOverride: "peer0.org1.example.com",
		// }),
		// Optional: orderer for full commit flow in peer mode
		// fabricbridge.WithOrderer("orderer.example.com:7050"),
	)

	// Connect to the network (gateway mode by default)
	bridge, err := fabricbridge.Connect(ctx, config)
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer bridge.Disconnect()

	fmt.Println("Connected to Fabric network via Gateway!")

	// Get network for a channel
	network, err := bridge.Network(ctx, "mychannel")
	if err != nil {
		log.Fatalf("Failed to get network: %v", err)
	}

	fmt.Printf("Connected to channel: %s\n", network.ChannelName())

	// Get contract
	contract := network.Contract("mycc")
	fmt.Printf("Got contract: %s\n", contract.ChaincodeName())

	// Example 1: Simple submit (gateway mode - waits for commit)
	// committed, err := contract.Submit(ctx, "CreateAsset", "asset1", "blue", "5", "Tom", "100")
	// if err != nil {
	//     log.Fatalf("Transaction failed: %v", err)
	// }
	// fmt.Printf("Transaction committed: %s\n", committed.TransactionID())
	// fmt.Printf("Block: %d Status: %s\n", committed.CommitStatus().BlockNumber, committed.CommitStatus().Status)

	// Example 1b: Submit async and wait later
	// submitted, err := contract.SubmitAsync(ctx, "CreateAsset", "asset2", "red", "10", "Ana", "200")
	// if err != nil {
	//     log.Fatalf("Async transaction failed: %v", err)
	// }
	// status, err := submitted.WaitForCommit(ctx)
	// if err != nil {
	//     log.Fatalf("Commit wait failed: %v", err)
	// }
	// fmt.Printf("Async transaction committed: %s in block %d\n", submitted.TransactionID(), status.BlockNumber)

	// Example 2: Submit with peer targeting
	// This triggers the sequential pattern:
	//   1. Disconnect from Gateway service
	//   2. Connect to peers via fabric-sdk-go (Endorser gRPC)
	//   3. Endorse/execute on specified peers
	//   4. Disconnect from peers
	//   5. Reconnect to Gateway service
	txBuilder := contract.Transaction("CreateAsset")
	txBuilder.SetEndorsingPeers("peer0.org1.example.com", "peer0.org2.example.com")
	txBuilder.SetTransientData(map[string][]byte{
		"privateData": []byte("secret"),
	})
	// committed, err := txBuilder.Submit(ctx, "asset1", "blue", "5", "Tom", "100")
	// if err != nil {
	//     log.Fatalf("Peer-targeted transaction failed: %v", err)
	// }
	// fmt.Printf("Peer-targeted tx committed: %s\n", committed.TransactionID())

	// Example 3: Evaluate with peer targeting
	// queryBuilder := contract.Transaction("ReadAsset")
	// queryBuilder.SetEndorsingPeers("peer0.org1.example.com")
	// result, err := queryBuilder.Evaluate(ctx, "asset1")
	// if err != nil {
	//     log.Fatalf("Peer-targeted query failed: %v", err)
	// }
	// fmt.Printf("Query result: %s\n", result)

	_ = txBuilder // suppress unused variable warning

	fmt.Println("Example completed successfully!")
}
