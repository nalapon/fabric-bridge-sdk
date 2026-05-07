# Fabric Bridge SDK

Fabric Bridge SDK exposes transaction submission patterns for Hyperledger Fabric clients across Node and Go runtimes.

## Language

**Single-peer transaction**:
A transaction whose proposal is sent to exactly one peer chosen before endorsement.
_Avoid_: single node transaction, one-node transaction

**Explicit peer targeting**:
A transaction targeting mode where the developer names the exact peers that must receive the proposal.
_Avoid_: candidate peer selection

**Candidate peer selection**:
A transaction targeting mode where the developer provides allowed peers and the SDK chooses exactly one of them.
_Avoid_: explicit peer targeting, fallback peer selection

**Discovered peer selection**:
A transaction targeting mode where the SDK chooses exactly one peer from the peers discovered for the channel.
_Avoid_: gateway peer selection

**Peer selection policy**:
The rule used by the SDK to choose one peer from an eligible peer set.
_Avoid_: load balancer, routing algorithm

**Single-peer failover**:
A retry behavior where the SDK tries another eligible peer after the selected peer fails.
_Avoid_: multi-peer transaction

**Single-peer execution failure**:
A failure returned after all eligible peers for a single-peer transaction have been attempted and failed.
_Avoid_: peer not found

**Single-peer failover log**:
A canonical structured log emitted when single-peer failover moves from one peer to another.
_Avoid_: debug trace, retry hook

**Failover eligibility**:
The classification that decides whether a failed single-peer attempt may be retried on another eligible peer.
_Avoid_: retryable error, string matching

**Transaction targeting**:
The transaction-level choice that decides whether the proposal uses gateway default routing, a single peer chosen by the SDK, or every named endorsing peer.
_Avoid_: peer mode flag, targeting fields

**SinglePeer API**:
The public transaction option that asks the SDK to choose one eligible peer per attempt.
_Avoid_: RandomPeer API, DiscoveredPeer API

**EndorsingPeers API**:
The public transaction option that asks the SDK to send the proposal to every named peer.
_Avoid_: SetEndorsingPeers

## Relationships

- **Transaction targeting** has exactly three modes: gateway default, single-peer, and endorsing-peers.
- Gateway default **Transaction targeting** uses the normal Gateway path and does not force peer mode.
- Gateway default **Transaction targeting** is the initial transaction state and is not exposed as a public reset API.
- Single-peer **Transaction targeting** uses the **SinglePeer API**.
- Endorsing-peers **Transaction targeting** uses the **EndorsingPeers API**.
- **Transaction targeting** is last-call-wins: setting a targeting mode replaces any previous targeting mode on the same transaction.
- **Transaction targeting** is represented as one value object with semantic operations, not as multiple sibling fields inspected across operation code.
- **Transaction targeting** owns only targeting intent and invariants; discovery, peer selection, failover, and Fabric peer adaptation remain separate concerns.
- **Transaction targeting** is an internal model; the public developer API remains the readable **SinglePeer API** and **EndorsingPeers API**.
- The internal **Transaction targeting** model is implemented in both Node and Go SDKs.
- A **Single-peer transaction** uses either **Candidate peer selection** or **Discovered peer selection**.
- A **Single-peer transaction** can be an evaluation or a submit operation.
- The **SinglePeer API** expresses automatic single-peer choice and is distinct from **Explicit peer targeting**.
- A candidate list passed to the **SinglePeer API** means "choose one of these peers" and never "send to all of these peers".
- Empty candidates in the **SinglePeer API** mean no candidate restriction, equivalent to **Discovered peer selection**.
- **Candidate peer selection** must fail when none of the candidates can be resolved to a discovered usable peer.
- **Explicit peer targeting** preserves the developer-provided peer set and does not choose among candidates.
- The **EndorsingPeers API** expresses **Explicit peer targeting** and sends the proposal to every named peer.
- The **EndorsingPeers API** requires at least one peer; an empty peer set is invalid **Transaction targeting**.
- The Node **SinglePeer API** uses an options object for candidates and policy.
- The Go **SinglePeer API** uses functional options for candidates and policy.
- Node and Go keep cohesive API names, but each runtime follows its own error-handling idioms.
- Node reports SDK operation errors through `better-result`; Go reports SDK errors through returned `error` values.
- In Go, **SinglePeer API** and **EndorsingPeers API** are mutable setters that return only `error`, not fluent builders.
- In Node, **SinglePeer API** and **EndorsingPeers API** return `better-result` values when local targeting validation can fail.
- In Node, a successful targeting setter returns the same mutable transaction builder inside `Result.ok`.
- The **SinglePeer API** always validates eligible peers through discovery, even when exactly one candidate is provided.
- The default **Peer selection policy** is round-robin scoped to the SDK instance and the effective peer set.
- The first supported **Peer selection policies** are round-robin and random.
- Unsupported **Peer selection policies** are invalid local targeting configuration.
- **Single-peer failover** still sends each attempt to exactly one peer and fails only after all eligible peers have failed.
- **Single-peer failover** is triggered only by transport, timeout, or peer availability failures.
- **Failover eligibility** is classified separately from **Peer selection policy**.
- **Failover eligibility** includes a category and reason, not just a yes-or-no decision.
- **Failover eligibility** categories are timeout, peer-unavailable, transport, non-retryable, and unknown.
- Unknown **Failover eligibility** does not trigger failover.
- Discovery failure does not trigger **Single-peer failover** because no eligible peer set has been established.
- Endorsement, policy, chaincode, and invalid commit failures are non-retryable for **Single-peer failover**.
- Non-retryable failures are returned as their original operation error, not as a **Single-peer execution failure**.
- A **Single-peer execution failure** reports the eligible peers, attempted peers, failure cause, and **Failover eligibility** for each attempt.
- A **Single-peer failover log** is emitted when the SDK retries an operation on another eligible peer.

## Example Dialogue

> **Dev:** "Can I pass three peers and let the SDK use only one?"
> **Domain expert:** "Yes, that is **Candidate peer selection**: the three peers are allowed candidates, and the SDK must choose exactly one or fail."

## Flagged Ambiguities

- "single peer" was used both for exact peer targeting and automatic choice of one peer; resolved: **Explicit peer targeting** and **Candidate peer selection** are distinct concepts.
