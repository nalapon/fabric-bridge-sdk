# Do not fail over offline single-peer signing

Offline signing on the **Single-peer path** will not perform automatic or assisted **Single-peer failover** in the first design. If endorsement fails for the peer recorded in the **Endorsement routing snapshot**, the signed proposal fails terminally; online single-peer transactions may still use automatic failover for eligible transport, timeout, or peer-availability failures.

## Consequences

- A signed offline single-peer proposal is bound operationally to one discovered peer endpoint.
- Retrying offline single-peer endorsement on another peer is a future explicit flow, not a continuation of the same signed proposal.
