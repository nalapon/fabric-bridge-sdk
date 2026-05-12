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

func (s *SimpleSigner) Sign(digest []byte) ([]byte, error) {
	// In production, sign digest with an HSM, KMS, or private-key implementation.
	return digest, nil
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

	// Example 2: Submit with single-peer targeting.
	// Peer-targeted operations use a dedicated peer adapter for the operation.
	txBuilder := contract.Transaction("CreateAsset")
	if err := txBuilder.UseSinglePeer(
		fabricbridge.WithCandidatePeers("peer0.org1.example.com", "peer0.org2.example.com"),
	); err != nil {
		log.Fatalf("Configure single-peer targeting failed: %v", err)
	}
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
	// if err := queryBuilder.UseSinglePeer(fabricbridge.WithCandidatePeers("peer0.org1.example.com")); err != nil {
	//     log.Fatalf("Configure single-peer targeting failed: %v", err)
	// }
	// result, err := queryBuilder.Evaluate(ctx, "asset1")
	// if err != nil {
	//     log.Fatalf("Peer-targeted query failed: %v", err)
	// }
	// fmt.Printf("Query result: %s\n", result)

	// Example 4: Offline transaction signing with gateway default routing
	// if err := runOfflineGatewayDefault(ctx, bridge, contract, signer); err != nil {
	//     log.Fatalf("Offline gateway-default flow failed: %v", err)
	// }

	// Example 5: Offline transaction signing with single-peer routing
	// if err := runOfflineSinglePeer(ctx, bridge, contract, signer); err != nil {
	//     log.Fatalf("Offline single-peer flow failed: %v", err)
	// }

	_ = txBuilder // suppress unused variable warning

	fmt.Println("Example completed successfully!")
}

func runOfflineGatewayDefault(ctx context.Context, bridge *fabricbridge.Bridge, contract *fabricbridge.Contract, signer fabricbridge.Signer) error {
	tx := contract.Transaction("CreateAsset")
	unsignedProposal, err := tx.NewUnsignedProposal(ctx, "asset-offline-gateway", "purple", "25", "Olivia", "500")
	if err != nil {
		return err
	}

	request := unsignedProposal.SigningRequest()
	fmt.Printf("Offline proposal routing: %s\n", request.Routing.Mode)

	proposalSignature, err := signDigest(signer, unsignedProposal.Digest())
	if err != nil {
		return err
	}

	signedProposal, err := bridge.NewSignedProposal(unsignedProposal.WithSignature(proposalSignature))
	if err != nil {
		return err
	}

	endorsed, err := signedProposal.Endorse(ctx)
	if err != nil {
		return err
	}

	committed, err := endorsed.Submit(ctx)
	if err != nil {
		return err
	}

	fmt.Printf("Offline gateway-default tx committed: %s\n", committed.TransactionID())
	return nil
}

func runOfflineSinglePeer(ctx context.Context, bridge *fabricbridge.Bridge, contract *fabricbridge.Contract, signer fabricbridge.Signer) error {
	tx := contract.Transaction("CreateAsset")
	if err := tx.UseSinglePeer(fabricbridge.WithCandidatePeers("peer0.org1.example.com")); err != nil {
		return err
	}

	unsignedProposal, err := tx.NewUnsignedProposal(ctx, "asset-offline-single-peer", "orange", "30", "Sam", "600")
	if err != nil {
		return err
	}

	request := unsignedProposal.SigningRequest()
	fmt.Printf("Offline proposal routing: %s %v\n", request.Routing.Mode, request.Routing.Peers)

	proposalSignature, err := signDigest(signer, unsignedProposal.Digest())
	if err != nil {
		return err
	}

	signedProposal, err := bridge.NewSignedProposal(unsignedProposal.WithSignature(proposalSignature))
	if err != nil {
		return err
	}

	endorsed, err := signedProposal.Endorse(ctx)
	if err != nil {
		return err
	}

	committed, err := endorsed.Submit(ctx)
	if err != nil {
		return err
	}

	fmt.Printf("Offline single-peer tx committed: %s\n", committed.TransactionID())
	return nil
}

func signDigest(signer fabricbridge.Signer, digest []byte) ([]byte, error) {
	return signer.Sign(digest)
}
