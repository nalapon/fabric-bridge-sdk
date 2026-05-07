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

**SinglePeer API**:
The public transaction option that asks the SDK to choose one eligible peer per attempt.
_Avoid_: RandomPeer API, DiscoveredPeer API

**EndorsingPeers API**:
The public transaction option that asks the SDK to send the proposal to every named peer.
_Avoid_: SetEndorsingPeers

## Relationships

- A **Single-peer transaction** uses either **Candidate peer selection** or **Discovered peer selection**.
- A **Single-peer transaction** can be an evaluation or a submit operation.
- The **SinglePeer API** expresses automatic single-peer choice and is distinct from **Explicit peer targeting**.
- A candidate list passed to the **SinglePeer API** means "choose one of these peers" and never "send to all of these peers".
- **Candidate peer selection** must fail when none of the candidates can be resolved to a discovered usable peer.
- **Explicit peer targeting** preserves the developer-provided peer set and does not choose among candidates.
- The **EndorsingPeers API** expresses **Explicit peer targeting** and sends the proposal to every named peer.
- The Node **SinglePeer API** uses an options object for candidates and policy.
- The Go **SinglePeer API** uses functional options for candidates and policy.
- The **SinglePeer API** always validates eligible peers through discovery, even when exactly one candidate is provided.
- The default **Peer selection policy** is round-robin scoped to the SDK instance and the effective peer set.
- The first supported **Peer selection policies** are round-robin and random.
- **Single-peer failover** still sends each attempt to exactly one peer and fails only after all eligible peers have failed.
- **Single-peer failover** is triggered only by transport, timeout, or peer availability failures.
- A **Single-peer execution failure** reports the eligible peers, attempted peers, and failure cause for each attempt.
- A **Single-peer failover log** is emitted when the SDK retries an operation on another eligible peer.

## Example Dialogue

> **Dev:** "Can I pass three peers and let the SDK use only one?"
> **Domain expert:** "Yes, that is **Candidate peer selection**: the three peers are allowed candidates, and the SDK must choose exactly one or fail."

## Flagged Ambiguities

- "single peer" was used both for exact peer targeting and automatic choice of one peer; resolved: **Explicit peer targeting** and **Candidate peer selection** are distinct concepts.
