# Build direct endorsement paths first

Fabric Bridge SDK exists primarily to support the **Single-peer path**, where each proposal attempt is sent to exactly one discovered peer, and also needs an **Explicit endorsement path** for callers that want to send a proposal to every peer in a caller-provided discovered peer list. The bridge-owned direct endorsement adapter will cover both paths in the first structural recut, while keeping their public interfaces distinct so a peer list never ambiguously means both "choose one" and "send to all".

## Consequences

- The **Single-peer path** sends each attempt to exactly one peer and may use online **Single-peer failover**.
- The **Explicit endorsement path** sends the proposal to every selected discovered peer and must validate multiple proposal responses before **Orderer submit**.
- The **Explicit endorsement path** sends endorsement requests concurrently to selected peers, without exposing concurrency tuning in the first public design.
- The **Explicit endorsement path** does not use failover; failure from any selected peer fails the operation.
- The **Explicit endorsement path** validates that all successful proposal response payloads are byte-for-byte identical and include endorsements before building a transaction.
- `UseEndorsingPeers` remains the public entry point for the **Explicit endorsement path**.
- The first new public design should not expose a toggle for online **Single-peer failover**; online failover is part of the **Single-peer path** behavior.
- The first new public design should not expose selectable peer policies; round-robin is the only **Peer selection policy** for the initial **Single-peer path**.
- ADR-0001 is superseded because it treated `UseEndorsingPeers` as part of the same initial transaction API.
