# Single-Peer Transaction API

Fabric Bridge SDK will expose `UseSinglePeer` as the recommended API for transactions that must send each proposal attempt to exactly one discovered peer, and `UseEndorsingPeers` for transactions that must send proposals to every named peer. This keeps automatic single-peer choice distinct from explicit multi-peer endorsement, which makes transaction code easier for developers and LLMs to read.

## Considered Options

- Keep `SetEndorsingPeers` as the main API and infer single-peer behavior from the number of peers provided.
- Add a separate `SetEndorsingPeer` API for one exact peer.
- Use `UseSinglePeer` for automatic single-peer choice and `UseEndorsingPeers` for explicit multi-peer targeting.

## Decision

Use `UseSinglePeer` for automatic single-peer choice. In Node, candidates and policy are passed with an options object. In Go, candidates and policy are passed with functional options.

`UseSinglePeer` always validates eligible peers through discovery. With no candidates, it chooses from all discovered eligible peers. With candidates, the candidates are an allow-list and the SDK chooses exactly one of them. A candidate list never means "send to all of these peers".

Use `UseEndorsingPeers` when the proposal must be sent to every named peer.

## Consequences

- `UseSinglePeer` applies to evaluate, submit, and submit-async operations.
- The default selection policy is round-robin, scoped to the SDK instance and effective peer set.
- The first supported selection policies are round-robin and random.
- Single-peer failover is enabled by default and tries the next eligible peer only for transport, timeout, or peer availability failures.
- Failover emits a canonical structured log when moving from one peer to another.
- If candidates cannot be resolved through discovery, the SDK returns a clear peer-resolution error.
- If every eligible peer fails during failover, the SDK returns a specific single-peer execution failure containing eligible peers, attempted peers, and causes.
