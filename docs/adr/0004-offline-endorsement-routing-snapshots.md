# Offline endorsement routing snapshots are exact peer endpoint records

Offline proposal signing stores an endorsement routing snapshot as the exact routing used when the signing request was created. The snapshot records only the routing mode and canonical peer endpoint identities, and offline resume revalidates those endpoints against current channel discovery before endorsement; it never reinterprets candidates or substitutes peers automatically. This favors signer intent, auditability, and predictable security over automatic availability during resume.

## Consequences

- Single-peer offline signing stores the one selected peer, not the candidate set.
- Endorsing-peers offline signing stores the resolved canonical peer list, deduplicated by endpoint identity.
- If any recorded endpoint is absent from current discovery during resume, the SDK fails locally before sending the signed proposal.
