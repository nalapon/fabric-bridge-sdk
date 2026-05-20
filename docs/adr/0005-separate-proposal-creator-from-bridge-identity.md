# Separate proposal creator from bridge identity

Offline proposal signing separates the **Proposal creator identity** from the **Bridge identity**: the transaction builder must be given an explicit proposal creator before it can build a proposal signing request, and the SDK never silently uses the bridge identity as the offline proposal creator. The external proposal signer signs only the proposal digest, while bridge-owned operations such as discovery, event handling, submit, and commit tracking are signed with the bridge signer.

## Consequences

- `BridgeConfig.identity.privateKey` is removed as Fabric identity signing material; `BridgeConfig.signer` is the bridge identity signing mechanism.
- Transport-layer mTLS key material remains separate and may still be supplied through TLS configuration.
- The transaction ID for an externally signed proposal is derived from the proposal nonce and explicit proposal creator identity.
- Signed proposal DTOs continue to carry canonical Fabric bytes and do not duplicate the proposal creator as separate metadata.
- `NewUnsignedProposal` fails as local configuration failure when no proposal creator identity has been configured.
