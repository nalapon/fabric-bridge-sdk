# Offline Proposal Signing

Fabric Bridge SDK will expose offline signing as proposal-only for now: the external signer signs the proposal, then the SDK uses the loaded bridge identity to sign and submit the endorsed transaction. This matches the default Fabric application flow more closely and keeps the offline signing interface small; full external transaction signing can be revisited later if a production use case needs it.

## Consequences

- A **Signing request** is a **Proposal signing request**.
- `SignedMessage` resumes only signed proposals.
- **Endorsed transaction** values should not expose a second signing request in the public offline flow.
- The signing DTO does not need a message type discriminator while the offline flow is proposal-only.
