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

	// Create config
	config := fabricbridge.NewConfig(
		"peer0.org1.example.com:7051",
		fabricbridge.Identity{
			MSPId:       "Org1MSP",
			Certificate: []byte("dummy-cert"), // In production, load real certificate
		},
		signer,
		fabricbridge.WithDiscovery(true),
		fabricbridge.WithTimeout(fabricbridge.TimeoutConfig{
			Endorse:  30 * time.Second,
			Submit:   30 * time.Second,
			Commit:   60 * time.Second,
			Evaluate: 30 * time.Second,
		}),
	)

	// Connect to the network
	bridge, err := fabricbridge.Connect(ctx, config)
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer bridge.Disconnect()

	fmt.Println("Connected to Fabric network!")

	// Get network for a channel
	network, err := bridge.Network(ctx, "mychannel")
	if err != nil {
		log.Fatalf("Failed to get network: %v", err)
	}

	fmt.Printf("Connected to channel: %s\n", network.ChannelName())

	// Get contract
	contract := network.Contract("mycc")
	fmt.Printf("Got contract: %s\n", contract.ChaincodeName())

	// Example: Evaluate a query
	// result, err := contract.Evaluate(ctx, "GetAllAssets")
	// if err != nil {
	//     log.Printf("Query failed: %v", err)
	// }
	// fmt.Printf("Query result: %s\n", result)

	// Example: Submit a transaction (gateway mode)
	// tx, err := contract.Submit(ctx, "CreateAsset", "asset1", "blue", "5", "Tom", "100")
	// if err != nil {
	//     log.Fatalf("Transaction failed: %v", err)
	// }
	// fmt.Printf("Transaction submitted: %s\n", tx.TransactionID())
	// fmt.Printf("Result: %s\n", tx.Result())

	// Example: Submit with peer targeting (peer mode)
	// txBuilder := contract.Transaction("CreateAsset")
	// txBuilder.SetEndorsingPeers("peer0.org1.example.com", "peer0.org2.example.com")
	// txBuilder.SetTransientData(map[string][]byte{
	//     "privateData": []byte("secret"),
	// })
	// tx, err := txBuilder.Submit(ctx, "asset1", "blue", "5", "Tom", "100")
	// if err != nil {
	//     log.Fatalf("Peer-targeted transaction failed: %v", err)
	// }
	// fmt.Printf("Transaction submitted: %s\n", tx.TransactionID())

	fmt.Println("Example completed successfully!")
}
