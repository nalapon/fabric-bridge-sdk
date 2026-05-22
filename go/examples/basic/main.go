package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	gatewayIdentity "github.com/hyperledger/fabric-gateway/pkg/identity"
	"github.com/kolokium/fabric-bridge-go/fabricbridge"
)

const (
	defaultChannel   = "mychannel"
	defaultChaincode = "basic"
)

type exampleConfig struct {
	GatewayEndpoint string
	DiscoverySeed   string
	OrdererEndpoint string
	MSPID           string
	CertPath        string
	KeyPath         string
	TLSRootPath     string
	Channel         string
	Chaincode       string
	Flow            string
	EndorsingPeers  []string
}

type privateKeySigner struct {
	sign gatewayIdentity.Sign
}

func (s privateKeySigner) Sign(digest []byte) ([]byte, error) {
	return s.sign(digest)
}

func main() {
	ctx := context.Background()
	settings := loadExampleConfig()

	certificate, err := readRequiredFile(settings.CertPath, "FABRIC_BRIDGE_CERT_PATH")
	if err != nil {
		log.Fatal(err)
	}
	signer, err := newPrivateKeySigner(settings.KeyPath)
	if err != nil {
		log.Fatal(err)
	}

	options := []fabricbridge.Option{
		fabricbridge.WithDiscoverySeed(settings.DiscoverySeed),
		fabricbridge.WithTimeout(fabricbridge.TimeoutConfig{
			Endorse:   30 * time.Second,
			Submit:    30 * time.Second,
			Commit:    60 * time.Second,
			Evaluate:  30 * time.Second,
			Discovery: 5 * time.Second,
		}),
	}
	if settings.OrdererEndpoint != "" {
		options = append(options, fabricbridge.WithOrderer(settings.OrdererEndpoint))
	}
	if settings.TLSRootPath != "" {
		tlsRoot, err := os.ReadFile(settings.TLSRootPath)
		if err != nil {
			log.Fatalf("read FABRIC_BRIDGE_TLS_ROOT_PATH: %v", err)
		}
		tlsOptions := fabricbridge.TLSOptions{TrustedRoots: tlsRoot}
		options = append(options,
			fabricbridge.WithGatewayTLS(tlsOptions),
			fabricbridge.WithDiscoveryTLS(tlsOptions),
			fabricbridge.WithOrdererTLS(tlsOptions),
		)
	}

	bridge, err := fabricbridge.Connect(ctx, fabricbridge.NewConfig(
		settings.GatewayEndpoint,
		fabricbridge.Identity{
			MSPId:       settings.MSPID,
			Certificate: certificate,
		},
		signer,
		options...,
	))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer bridge.Disconnect()

	network, err := bridge.Network(ctx, settings.Channel)
	if err != nil {
		log.Fatalf("network: %v", err)
	}
	contract := network.Contract(settings.Chaincode)

	switch settings.Flow {
	case "gateway":
		err = runGatewayFlow(ctx, contract)
	case "single-peer":
		err = runSinglePeerFlow(ctx, contract)
	case "endorsing-peers":
		err = runEndorsingPeersFlow(ctx, contract, settings.EndorsingPeers)
	case "offline-gateway":
		err = runOfflineGatewayFlow(ctx, bridge, contract, settings.MSPID, certificate, signer)
	case "offline-single-peer":
		err = runOfflineSinglePeerFlow(ctx, bridge, contract, settings.MSPID, certificate, signer)
	case "offline-endorsing-peers":
		err = runOfflineEndorsingPeersFlow(ctx, bridge, contract, settings.MSPID, certificate, signer, settings.EndorsingPeers)
	default:
		err = fmt.Errorf("unsupported FABRIC_BRIDGE_EXAMPLE_FLOW %q", settings.Flow)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func runGatewayFlow(ctx context.Context, contract *fabricbridge.Contract) error {
	result, err := contract.Evaluate(ctx, "GetAllAssets")
	if err != nil {
		return fmt.Errorf("gateway evaluate: %w", err)
	}
	fmt.Printf("gateway evaluate result: %s\n", result)

	committed, err := contract.Submit(ctx, "CreateAsset", "asset-gateway", "blue", "5", "Tom", "100")
	if err != nil {
		return fmt.Errorf("gateway submit: %w", err)
	}
	fmt.Printf("gateway submit committed tx=%s block=%d status=%s\n",
		committed.TransactionID(),
		committed.CommitStatus().BlockNumber,
		committed.CommitStatus().Status,
	)
	return nil
}

func runSinglePeerFlow(ctx context.Context, contract *fabricbridge.Contract) error {
	tx := contract.Transaction("CreateAsset")
	if err := tx.UseSinglePeer(); err != nil {
		return err
	}
	tx.SetTransientData(map[string][]byte{"privateData": []byte("single-peer-secret")})

	committed, err := tx.Submit(ctx, "asset-single-peer", "green", "7", "Ana", "200")
	if err != nil {
		return fmt.Errorf("single-peer submit: %w", err)
	}
	fmt.Printf("single-peer submit committed tx=%s block=%d status=%s\n",
		committed.TransactionID(),
		committed.CommitStatus().BlockNumber,
		committed.CommitStatus().Status,
	)
	return nil
}

func runEndorsingPeersFlow(ctx context.Context, contract *fabricbridge.Contract, peers []string) error {
	if len(peers) == 0 {
		return fmt.Errorf("FABRIC_BRIDGE_ENDORSING_PEERS is required for endorsing-peers flow")
	}

	tx := contract.Transaction("CreateAsset")
	if err := tx.UseEndorsingPeers(peers...); err != nil {
		return err
	}
	tx.SetTransientData(map[string][]byte{"privateData": []byte("explicit-endorsement-secret")})

	committed, err := tx.Submit(ctx, "asset-endorsing-peers", "red", "9", "Maria", "300")
	if err != nil {
		return fmt.Errorf("endorsing-peers submit: %w", err)
	}
	fmt.Printf("endorsing-peers submit committed tx=%s block=%d status=%s peers=%v\n",
		committed.TransactionID(),
		committed.CommitStatus().BlockNumber,
		committed.CommitStatus().Status,
		peers,
	)
	return nil
}

func runOfflineGatewayFlow(ctx context.Context, bridge *fabricbridge.Bridge, contract *fabricbridge.Contract, mspID string, cert []byte, signer fabricbridge.Signer) error {
	tx := contract.Transaction("CreateAsset").SetProposalCreator(proposalCreator(mspID, cert))
	unsigned, err := tx.NewUnsignedProposal(ctx, "asset-offline-gateway", "purple", "25", "Olivia", "500")
	if err != nil {
		return err
	}
	return signEndorseAndSubmit(ctx, bridge, signer, unsigned)
}

func runOfflineSinglePeerFlow(ctx context.Context, bridge *fabricbridge.Bridge, contract *fabricbridge.Contract, mspID string, cert []byte, signer fabricbridge.Signer) error {
	tx := contract.Transaction("CreateAsset").SetProposalCreator(proposalCreator(mspID, cert))
	if err := tx.UseSinglePeer(); err != nil {
		return err
	}

	unsigned, err := tx.NewUnsignedProposal(ctx, "asset-offline-single-peer", "orange", "30", "Sam", "600")
	if err != nil {
		return err
	}
	return signEndorseAndSubmit(ctx, bridge, signer, unsigned)
}

func runOfflineEndorsingPeersFlow(ctx context.Context, bridge *fabricbridge.Bridge, contract *fabricbridge.Contract, mspID string, cert []byte, signer fabricbridge.Signer, peers []string) error {
	if len(peers) == 0 {
		return fmt.Errorf("FABRIC_BRIDGE_ENDORSING_PEERS is required for offline-endorsing-peers flow")
	}

	tx := contract.Transaction("CreateAsset").SetProposalCreator(proposalCreator(mspID, cert))
	if err := tx.UseEndorsingPeers(peers...); err != nil {
		return err
	}

	unsigned, err := tx.NewUnsignedProposal(ctx, "asset-offline-endorsing-peers", "yellow", "35", "Lee", "700")
	if err != nil {
		return err
	}
	return signEndorseAndSubmit(ctx, bridge, signer, unsigned)
}

func signEndorseAndSubmit(ctx context.Context, bridge *fabricbridge.Bridge, signer fabricbridge.Signer, unsigned *fabricbridge.UnsignedProposal) error {
	request := unsigned.SigningRequest()
	if request.Routing != nil {
		fmt.Printf("offline signing routing mode=%s peers=%v\n", request.Routing.Mode, request.Routing.Peers)
	}

	signature, err := signer.Sign(unsigned.Digest())
	if err != nil {
		return fmt.Errorf("sign proposal digest: %w", err)
	}
	signed, err := bridge.NewSignedProposal(unsigned.WithSignature(signature))
	if err != nil {
		return err
	}
	endorsed, err := signed.Endorse(ctx)
	if err != nil {
		return err
	}
	committed, err := endorsed.Submit(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("offline submit committed tx=%s block=%d status=%s\n",
		committed.TransactionID(),
		committed.CommitStatus().BlockNumber,
		committed.CommitStatus().Status,
	)
	return nil
}

func loadExampleConfig() exampleConfig {
	gatewayEndpoint := requiredEnv("FABRIC_BRIDGE_GATEWAY_ENDPOINT")
	return exampleConfig{
		GatewayEndpoint: gatewayEndpoint,
		DiscoverySeed:   envOrDefault("FABRIC_BRIDGE_DISCOVERY_SEED", gatewayEndpoint),
		OrdererEndpoint: os.Getenv("FABRIC_BRIDGE_ORDERER_ENDPOINT"),
		MSPID:           requiredEnv("FABRIC_BRIDGE_MSP_ID"),
		CertPath:        requiredEnv("FABRIC_BRIDGE_CERT_PATH"),
		KeyPath:         requiredEnv("FABRIC_BRIDGE_KEY_PATH"),
		TLSRootPath:     os.Getenv("FABRIC_BRIDGE_TLS_ROOT_PATH"),
		Channel:         envOrDefault("FABRIC_BRIDGE_CHANNEL", defaultChannel),
		Chaincode:       envOrDefault("FABRIC_BRIDGE_CHAINCODE", defaultChaincode),
		Flow:            envOrDefault("FABRIC_BRIDGE_EXAMPLE_FLOW", "gateway"),
		EndorsingPeers:  splitCSV(os.Getenv("FABRIC_BRIDGE_ENDORSING_PEERS")),
	}
}

func newPrivateKeySigner(path string) (fabricbridge.Signer, error) {
	keyBytes, err := readRequiredFile(path, "FABRIC_BRIDGE_KEY_PATH")
	if err != nil {
		return nil, err
	}
	privateKey, err := parsePrivateKey(keyBytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	sign, err := gatewayIdentity.NewPrivateKeySign(privateKey)
	if err != nil {
		return nil, fmt.Errorf("create signer: %w", err)
	}
	return privateKeySigner{sign: sign}, nil
}

func parsePrivateKey(keyPEM []byte) (crypto.PrivateKey, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, fmt.Errorf("PEM block not found")
	}

	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		return supportedPrivateKey(key)
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return supportedPrivateKey(key)
	}

	return nil, fmt.Errorf("private key must be PKCS#8 or EC PEM")
}

func supportedPrivateKey(key crypto.PrivateKey) (crypto.PrivateKey, error) {
	switch key.(type) {
	case *ecdsa.PrivateKey, ed25519.PrivateKey:
		return key, nil
	default:
		return nil, fmt.Errorf("private key type %T is not supported by this example", key)
	}
}

func proposalCreator(mspID string, cert []byte) fabricbridge.ProposalCreator {
	return fabricbridge.ProposalCreator{
		MSPId:       mspID,
		Certificate: append([]byte(nil), cert...),
	}
}

func readRequiredFile(path string, envName string) ([]byte, error) {
	if path == "" {
		return nil, fmt.Errorf("%s is required", envName)
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", envName, err)
	}
	return value, nil
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func envOrDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			out = append(out, item)
		}
	}
	return out
}
