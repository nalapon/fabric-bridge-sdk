# Fabric Bridge Go SDK

A Go SDK that provides a unified interface for both Hyperledger Fabric Gateway (modern) and Fabric SDK Go (deprecated) with peer-targeting support.

## Overview

This SDK provides:
- **Gateway Mode** (default): Uses the modern `fabric-gateway` SDK for standard transactions
- **Peer-Targeting Mode**: Uses the deprecated `fabric-sdk-go` for sending transactions to specific peers

## Installation

```bash
go get github.com/kolokium/fabric-bridge-go/fabricbridge
```

## Usage

### Basic Connection

```go
package main

import (
    "context"
    "log"
    "time"
    
    "github.com/kolokium/fabric-bridge-go/fabricbridge"
)

type SimpleSigner struct {
    privateKey []byte
}

func (s *SimpleSigner) Sign(message []byte) ([]byte, error) {
    // Implement your signing logic here
    return message, nil
}

func main() {
    ctx := context.Background()
    
    // Create signer
    signer := &SimpleSigner{privateKey: loadPrivateKey()}
    
    // Create config
    config := fabricbridge.NewConfig(
        "peer0.org1.example.com:7051",
        fabricbridge.Identity{
            MSPId:       "Org1MSP",
            Certificate: loadCertificate(),
        },
        signer,
        fabricbridge.WithDiscovery(true),
        fabricbridge.WithTLS(fabricbridge.TLSOptions{
            TrustedRoots: loadTLSCert(),
        }),
    )
    
    // Connect
    bridge, err := fabricbridge.Connect(ctx, config)
    if err != nil {
        log.Fatalf("Failed to connect: %v", err)
    }
    defer bridge.Disconnect()
    
    // Get network
    network, err := bridge.Network(ctx, "mychannel")
    if err != nil {
        log.Fatalf("Failed to get network: %v", err)
    }
    
    // Get contract
    contract := network.Contract("mycc")
    
    // Execute query (gateway mode)
    result, err := contract.Evaluate(ctx, "GetAllAssets")
    if err != nil {
        log.Printf("Query failed: %v", err)
    }
    
    // Submit transaction (gateway mode)
    tx, err := contract.Submit(ctx, "CreateAsset", "asset1", "blue", "5", "Tom", "100")
    if err != nil {
        log.Fatalf("Transaction failed: %v", err)
    }
    
    log.Printf("Transaction ID: %s", tx.TransactionID())
    log.Printf("Result: %s", tx.Result())
    
    // Check commit status
    status, err := tx.Status(ctx)
    if err != nil {
        log.Printf("Failed to get status: %v", err)
    } else {
        log.Printf("Block: %d, Status: %v", status.BlockNumber, status.Status)
    }
}
```

### Peer-Targeting Mode

```go
// Get contract with peer targeting support
contract := network.Contract("mycc")

// Create transaction with specific endorsing peers
tx := contract.Transaction("CreateAsset")
tx.SetEndorsingPeers("peer0.org1.example.com", "peer0.org2.example.com")
tx.SetTransientData(map[string][]byte{
    "privateData": []byte("secret"),
})

// Submit to specific peers
result, err := tx.Submit(ctx, "asset1", "blue", "5", "Tom", "100")
if err != nil {
    log.Fatalf("Peer-targeted transaction failed: %v", err)
}

log.Printf("Transaction ID: %s", result.TransactionID())
```

## API Reference

### Bridge

The main entry point for connecting to the Fabric network.

```go
// Connect to the network
bridge, err := fabricbridge.Connect(ctx, config)

// Disconnect when done
bridge.Disconnect()

// Check connection status
if bridge.IsConnected() {
    // ...
}

// Get network for a channel
network, err := bridge.Network(ctx, "mychannel")
```

### Network

Represents a Fabric channel.

```go
// Get channel name
channelName := network.ChannelName()

// Get contract for chaincode
contract := network.Contract("mycc")
contract := network.Contract("mycc", "MyContract") // with contract name
```

### Contract

Represents a smart contract.

```go
// Get chaincode name
name := contract.ChaincodeName()

// Evaluate (query) - read-only
result, err := contract.Evaluate(ctx, "GetAsset", "asset1")

// Submit transaction - write
result, err := contract.Submit(ctx, "CreateAsset", "asset1", "blue", "5")

// Create transaction builder for advanced options
tx := contract.Transaction("CreateAsset")
```

### Transaction

Builder for transactions with custom options.

```go
tx := contract.Transaction("CreateAsset")

// Set specific endorsing peers (peer-targeting mode)
tx.SetEndorsingPeers("peer0.org1.example.com", "peer0.org2.example.com")

// Set transient data
tx.SetTransientData(map[string][]byte{
    "privateData": []byte("secret"),
})

// Submit
result, err := tx.Submit(ctx, "asset1", "blue", "5")

// Or evaluate
result, err := tx.Evaluate(ctx, "asset1")
```

### TransactionResult

Result of a submitted transaction.

```go
// Get transaction ID
txID := result.TransactionID()

// Get result payload
data := result.Result()

// Check commit status
status, err := result.Status(ctx)
if err != nil {
    log.Printf("Status: Block %d, Code %v", status.BlockNumber, status.Status)
}
```

## Configuration

### Config Structure

```go
type Config struct {
    GatewayPeer string           // Gateway peer endpoint (e.g., "peer0.org1.example.com:7051")
    Identity    Identity         // Client identity
    Signer      Signer           // Signing implementation
    TLSOptions  *TLSOptions      // TLS configuration (optional)
    Discovery   bool             // Enable discovery for peer targeting (default: true)
    Timeouts    TimeoutConfig    // Timeout settings
}

type Identity struct {
    MSPId       string  // MSP ID (e.g., "Org1MSP")
    Certificate []byte  // X.509 certificate in PEM format
    PrivateKey  []byte  // Private key (optional, only needed for peer mode)
}

type TLSOptions struct {
    TrustedRoots []byte  // Root CA certificates
    Verify       bool     // Verify server certificate (default: true)
    ClientCert   []byte  // Client certificate for mutual TLS (optional)
    ClientKey    []byte  // Client key for mutual TLS (optional)
}

type TimeoutConfig struct {
    Endorse   time.Duration  // Endorsement timeout (default: 30s)
    Submit    time.Duration  // Submit timeout (default: 30s)
    Commit    time.Duration  // Commit timeout (default: 60s)
    Evaluate  time.Duration  // Evaluate timeout (default: 30s)
    Discovery time.Duration  // Discovery timeout (default: 5s)
}
```

### Functional Options

```go
// With custom timeouts
config := fabricbridge.NewConfig(
    gatewayPeer,
    identity,
    signer,
    fabricbridge.WithTimeout(fabricbridge.TimeoutConfig{
        Endorse:  45 * time.Second,
        Submit:   45 * time.Second,
        Commit:   90 * time.Second,
        Evaluate: 45 * time.Second,
    }),
)

// Disable discovery
config := fabricbridge.NewConfig(
    gatewayPeer,
    identity,
    signer,
    fabricbridge.WithDiscovery(false),
)

// With TLS
config := fabricbridge.NewConfig(
    gatewayPeer,
    identity,
    signer,
    fabricbridge.WithTLS(fabricbridge.TLSOptions{
        TrustedRoots: loadRootCA(),
        Verify:       true,
    }),
)
```

## Error Handling

The SDK uses idiomatic Go error handling with custom error types:

```go
result, err := contract.Submit(ctx, "CreateAsset", "arg1")
if err != nil {
    // Check specific error types
    var endorsementErr *fabricbridge.EndorsementError
    if errors.As(err, &endorsementErr) {
        log.Printf("Endorsement failed: %v", endorsementErr)
    }
    
    var submitErr *fabricbridge.SubmitError
    if errors.As(err, &submitErr) {
        log.Printf("Submit failed: %v", submitErr)
    }
    
    var timeoutErr *fabricbridge.TimeoutError
    if errors.As(err, &timeoutErr) {
        log.Printf("Timeout: %v", timeoutErr)
    }
}
```

### Error Types

- `ConfigurationError` - Invalid configuration
- `ConnectionError` - Connection failures
- `EndorsementError` - Endorsement failures
- `SubmitError` - Transaction submission failures
- `CommitError` - Commit status retrieval failures
- `EvaluationError` - Query evaluation failures
- `DiscoveryError` - Discovery service failures
- `PeerNotFoundError` - Peer not found in discovery
- `TimeoutError` - Operation timeout
- `NotConnectedError` - Bridge not connected

## Architecture

The SDK has two operational modes:

### Gateway Mode (Default)
- Uses `fabric-gateway` SDK (v1.10.1)
- Modern, recommended approach
- Automatic endorsement gathering
- Simplified API
- No peer targeting

### Peer-Targeting Mode
- Uses `fabric-sdk-go` SDK (v1.0.0)
- Deprecated but functional
- Supports explicit peer selection
- Used when `SetEndorsingPeers()` is called
- Requires discovery to be enabled

### Mode Selection

The SDK automatically selects the mode based on usage:

```go
// Gateway mode (automatic)
contract.Submit(ctx, "func", args...)

// Peer-targeting mode (explicit peers)
tx := contract.Transaction("func")
tx.SetEndorsingPeers("peer1", "peer2")
tx.Submit(ctx, args...)
```

## Implementation Status

✅ **Completed:**
- Core bridge connection using fabric-gateway
- Network and Contract abstractions
- Transaction builder pattern
- Idiomatic Go error handling
- Context-first API design
- Functional options pattern
- TLS support
- Peer connection management using fabric-sdk-go
- Peer-targeting mode implementation

🔜 **Future Enhancements:**
- Event listening (block events, chaincode events)
- Discovery service caching improvements
- Connection pooling for peer connections
- Retry policies with exponential backoff
- Health checks and connection recovery
- Wallet integration
- More comprehensive examples

## Dependencies

```
github.com/hyperledger/fabric-gateway v1.10.1
github.com/hyperledger/fabric-sdk-go v1.0.0
google.golang.org/grpc v1.68.0
```

## License

MIT

## Contributing

Contributions are welcome! Please ensure:
1. Code follows Go best practices
2. Tests are included for new features
3. Documentation is updated
4. `go vet` and `go build` pass cleanly
