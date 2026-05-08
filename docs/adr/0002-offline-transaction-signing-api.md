# Offline Transaction Signing API

Fabric Bridge SDK will expose offline transaction signing as a bridge-owned API across Node and Go, covering gateway default, single-peer, and endorsing-peers transaction targeting. Node and Go expose the same concepts and method names, but each runtime owns its own signing DTO representation instead of guaranteeing cross-runtime resume.

## Considered Options

- Expose only the Fabric Gateway offline signing API and leave peer-targeted transactions unsupported.
- Keep signing requests minimal with only message bytes and digest.
- Use runtime-specific signing request DTOs with only the operational metadata required to resume the same flow in that runtime.

## Decision

Use `Transaction` as the factory for unsigned proposal signing requests. Use the bridge root object to rehydrate signed proposal and signed transaction DTOs into runtime flow objects.

Signing requests use JSON DTOs per runtime. Binary fields, including message bytes, digest, and signature, are base64 encoded. The canonical Fabric bytes are the source of truth. The bridge validates that the supplied digest matches those bytes, but it does not verify the external signature cryptographically before sending to Fabric.

Proposal signing requests include an endorsement routing snapshot because peer routing is not encoded in the Fabric proposal. The snapshot records gateway default routing, one resolved peer endpoint for single-peer targeting, or resolved peer endpoints for endorsing-peers targeting. Endorsed transaction signing requests do not include routing because peer routing ends after endorsement.

Offline signing never falls back to the bridge signer for proposal or transaction signatures. If a required external signature is missing, the offline flow fails with an offline signing error. After a signed transaction is submitted, commit tracking uses the existing bridge identity and signer behavior.

## Consequences

- Offline signing can be resumed in the same runtime as long as the receiving bridge has compatible network, TLS, discovery, and orderer configuration.
- Single-peer failover in offline signing requires a new proposal signing request and a new external signature for each attempted peer.
- Commit waiting, events, timeouts, and submit result handling remain the same as the existing transaction flow.
