# Use direct Fabric service discovery for the direct endorsement path

The **Direct endorsement path** will use direct Fabric service discovery against peers instead of asking the Gateway service for peer information. This keeps the **Single-peer path**, **Explicit endorsement path**, and offline resume validation independent of Gateway endorsement routing, at the cost of owning a smaller discovery client inside the bridge-owned peer adapter.

## Consequences

- The bridge-owned adapter must retain enough Fabric discovery protocol support to resolve channel peers.
- Gateway default routing remains available for normal gateway transactions, but it is not the discovery source for the **Direct endorsement path**.
- Configuration should model **Gateway endpoint** and **Discovery seed** as separate roles. For developer experience, an omitted **Discovery seed** may default to the **Gateway endpoint**.
- TLS configuration should be modeled per role: gateway, discovery, and orderer. Discovery and orderer TLS may default to gateway TLS when omitted.
