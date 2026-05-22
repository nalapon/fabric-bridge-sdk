# Fabric Bridge Go SDK

Go SDK for Hyperledger Fabric applications that need both the normal Gateway path and bridge-owned direct endorsement paths.

## Transaction Paths

- **Gateway**: default path. Uses the Fabric Gateway service for normal application transactions.
- **Single peer**: call `UseSinglePeer()` to endorse through one discovered peer, then submit directly to the orderer and wait for commit status through Gateway.
- **Explicit endorsement**: call `UseEndorsingPeers(...)` to endorse concurrently through the exact discovered peers supplied by the caller, then submit directly to the orderer and wait for commit status through Gateway.

Fabric service discovery is part of the direct endorsement model. `DiscoverySeed` defaults to `GatewayEndpoint`, but production code should set it explicitly when gateway, discovery, and orderer endpoints are different.

## Installation

```bash
go get github.com/kolokium/fabric-bridge-go/fabricbridge
```

## Runnable Example

The main Go example is in `examples/basic`.

```bash
cd go

export FABRIC_BRIDGE_GATEWAY_ENDPOINT=peer0.org1.example.com:7051
export FABRIC_BRIDGE_DISCOVERY_SEED=peer0.org1.example.com:7051
export FABRIC_BRIDGE_ORDERER_ENDPOINT=orderer.example.com:7050
export FABRIC_BRIDGE_MSP_ID=Org1MSP
export FABRIC_BRIDGE_CERT_PATH=/path/to/signcert.pem
export FABRIC_BRIDGE_KEY_PATH=/path/to/private-key.pem
export FABRIC_BRIDGE_TLS_ROOT_PATH=/path/to/tls-ca.pem
export FABRIC_BRIDGE_CHANNEL=mychannel
export FABRIC_BRIDGE_CHAINCODE=basic

go run ./examples/basic
```

Set `FABRIC_BRIDGE_EXAMPLE_FLOW` to choose the path:

```bash
FABRIC_BRIDGE_EXAMPLE_FLOW=gateway go run ./examples/basic
FABRIC_BRIDGE_EXAMPLE_FLOW=single-peer go run ./examples/basic

export FABRIC_BRIDGE_ENDORSING_PEERS=peer0.org1.example.com:7051,peer0.org2.example.com:9051
FABRIC_BRIDGE_EXAMPLE_FLOW=endorsing-peers go run ./examples/basic
FABRIC_BRIDGE_EXAMPLE_FLOW=offline-gateway go run ./examples/basic
FABRIC_BRIDGE_EXAMPLE_FLOW=offline-single-peer go run ./examples/basic
FABRIC_BRIDGE_EXAMPLE_FLOW=offline-endorsing-peers go run ./examples/basic
```

## Basic Usage

```go
config := fabricbridge.NewConfig(
    "peer0.org1.example.com:7051",
    fabricbridge.Identity{
        MSPId:       "Org1MSP",
        Certificate: certificatePEM,
    },
    signer,
    fabricbridge.WithDiscoverySeed("peer0.org1.example.com:7051"),
    fabricbridge.WithOrderer("orderer.example.com:7050"),
    fabricbridge.WithGatewayTLS(fabricbridge.TLSOptions{TrustedRoots: tlsRootPEM}),
    fabricbridge.WithDiscoveryTLS(fabricbridge.TLSOptions{TrustedRoots: tlsRootPEM}),
    fabricbridge.WithOrdererTLS(fabricbridge.TLSOptions{TrustedRoots: tlsRootPEM}),
)

bridge, err := fabricbridge.Connect(ctx, config)
if err != nil {
    return err
}
defer bridge.Disconnect()

network, err := bridge.Network(ctx, "mychannel")
if err != nil {
    return err
}
contract := network.Contract("basic")
```

## Gateway

```go
result, err := contract.Evaluate(ctx, "GetAllAssets")
if err != nil {
    return err
}

committed, err := contract.Submit(ctx, "CreateAsset", "asset1", "blue", "5", "Tom", "100")
if err != nil {
    return err
}

fmt.Println(committed.TransactionID(), committed.CommitStatus().Status, result)
```

## Single Peer

`UseSinglePeer()` is for the bridge-specific case where the application wants one discovered peer to endorse the transaction.

```go
tx := contract.Transaction("CreateAsset")
if err := tx.UseSinglePeer(); err != nil {
    return err
}

committed, err := tx.Submit(ctx, "asset-single", "green", "7", "Ana", "200")
if err != nil {
    return err
}

fmt.Println(committed.TransactionID(), committed.CommitStatus().Status)
```

## Explicit Endorsement

`UseEndorsingPeers(...)` is for caller-selected multi-endorsement. Every supplied peer must be present in Fabric discovery, and the SDK sends the proposal to all resolved targets.

```go
tx := contract.Transaction("CreateAsset")
if err := tx.UseEndorsingPeers(
    "peer0.org1.example.com:7051",
    "peer0.org2.example.com:9051",
); err != nil {
    return err
}

committed, err := tx.Submit(ctx, "asset-explicit", "red", "9", "Maria", "300")
if err != nil {
    return err
}

fmt.Println(committed.TransactionID(), committed.CommitStatus().Status)
```

## Offline Signing

Offline signing uses the same routing decision as the transaction builder:

```go
tx := contract.Transaction("CreateAsset").SetProposalCreator(fabricbridge.ProposalCreator{
    MSPId:       "Org1MSP",
    Certificate: certificatePEM,
})

// Optional direct endorsement routing:
// _ = tx.UseSinglePeer()
// _ = tx.UseEndorsingPeers("peer0.org1.example.com:7051", "peer0.org2.example.com:9051")

unsigned, err := tx.NewUnsignedProposal(ctx, "asset-offline", "purple", "25", "Olivia", "500")
if err != nil {
    return err
}

signature, err := signer.Sign(unsigned.Digest())
if err != nil {
    return err
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
```

## Key Configuration

```go
type Config struct {
    GatewayEndpoint string
    DiscoverySeed   string
    OrdererEndpoint string
    Identity        Identity
    Signer          Signer
    GatewayTLS      *TLSOptions
    DiscoveryTLS    *TLSOptions
    OrdererTLS      *TLSOptions
    Discovery       bool
    Timeouts        TimeoutConfig
}
```

Important options:

- `WithDiscoverySeed(endpoint)`: initial peer endpoint for Fabric service discovery.
- `WithOrderer(endpoint)`: required for `UseSinglePeer()` and `UseEndorsingPeers()` submit flows.
- `WithGatewayTLS(...)`, `WithDiscoveryTLS(...)`, `WithOrdererTLS(...)`: separate TLS roles for each endpoint.
- `WithTimeout(...)`: operation timeouts, including `Discovery`.

## Error Types

- `ConfigurationError`
- `ConnectionError`
- `DiscoveryError`
- `PeerNotFoundError`
- `SinglePeerExecutionError`
- `EndorsementError`
- `SubmitError`
- `CommitError`
- `EvaluationError`
- `OfflineSigningError`
- `TimeoutError`
- `NotConnectedError`
