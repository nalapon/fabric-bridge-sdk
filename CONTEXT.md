# Fabric Bridge SDK

Fabric Bridge SDK exposes transaction submission patterns for Hyperledger Fabric clients across Node and Go runtimes.

## Language

**Single-peer transaction**:
A transaction whose proposal is sent to exactly one peer chosen before endorsement.
_Avoid_: single node transaction, one-node transaction

**Explicit peer targeting**:
A transaction targeting mode where the developer names the exact peers that must receive the proposal.
_Avoid_: candidate peer selection

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

**Gateway path**:
The normal Fabric Gateway transaction path where the Gateway service handles endorsement routing for standard Fabric applications.
_Avoid_: default peer path

**Single-peer path**:
The primary Fabric Bridge SDK transaction path where each proposal attempt is sent to exactly one discovered peer.
_Avoid_: one-node path, explicit endorsement path

**Explicit endorsement path**:
The transaction path where the caller supplies the exact discovered peers that must receive the proposal.
_Avoid_: single-peer path, gateway path

**Direct endorsement path**:
The bridge-owned transaction path family that sends proposals directly to discovered peers instead of letting Gateway choose endorsement routing.
_Avoid_: legacy SDK path, peer mode

**Fabric service discovery**:
The Fabric network mechanism the SDK uses to obtain the channel peer set before applying **Transaction targeting**.
_Avoid_: configured peer list, manual peer registry

**Discovery seed**:
The initial peer endpoint the SDK contacts to run **Fabric service discovery**; it is not automatically an endorsement target.
_Avoid_: selected peer, target peer

**Gateway endpoint**:
The Fabric Gateway service endpoint used for gateway default transactions, gateway offline resume, and commit status queries.
_Avoid_: discovery seed, orderer endpoint

**Gateway submit**:
Submitting a prepared transaction through the Fabric Gateway service.
_Avoid_: direct submit

**Orderer submit**:
Submitting a prepared transaction directly to the Fabric orderer.
_Avoid_: direct submit

**Offline transaction signing**:
A transaction flow where the SDK builds signable Fabric messages but an external signer supplies the required signatures.
_Avoid_: asynchronous signing, async transaction signing

**Bridge signable message**:
A bridge-owned representation of a Fabric message that exposes bytes, digest, and transaction identity for external signing.
_Avoid_: gateway proposal, legacy proposal wrapper

**Message digest**:
The byte sequence exposed by a **Bridge signable message** as the value external signers are expected to sign.
_Avoid_: full message bytes as signing input

**Signing request**:
A portable representation of a **Bridge signable message** that carries canonical Fabric bytes, **Message digest**, and only the operational metadata needed to resume the flow.
_Avoid_: serialized SDK object, reconstructed proposal

**Proposal signing request**:
A **Signing request** whose canonical Fabric bytes represent a proposal to be signed externally before endorsement.
_Avoid_: transaction signing request, full offline transaction signing

**Proposal creator identity**:
The serialized Fabric identity embedded in a proposal and bound to the proposal signature.
_Avoid_: submitter identity, orderer sender identity

**Bridge identity**:
The Fabric identity loaded in the SDK for network operations such as connection, discovery, submit, and commit tracking.
_Avoid_: proposal creator identity, external signer identity

**External proposal signer**:
The signer outside the SDK that signs the **Message digest** for a proposal.
_Avoid_: bridge signer, orderer signer, application identity provider

**Signing request wire format**:
The runtime-specific JSON representation of a **Signing request**, with every binary field encoded as base64.
_Avoid_: protobuf wrapper, hex digest

**Endorsement routing snapshot**:
The operational metadata in a proposal **Signing request** that records whether endorsement should use gateway default routing, one selected peer, or explicit endorsing peers.
_Avoid_: duplicated transaction metadata

**Peer endpoint identity**:
The exact endpoint used to identify a discovered peer for targeting and offline endorsement routing; developer input may be `host:port` or `grpc(s)://host:port`, while snapshots store canonical `grpc(s)://host:port` URLs.
_Avoid_: partial peer name, substring match

**Offline signing flow object**:
A runtime object that resumes or advances **Offline transaction signing** from a signing DTO and exposes behavior such as endorse or submit.
_Avoid_: raw JSON operation target

**Endorsed transaction**:
A Fabric transaction produced by endorsing a signed proposal and ready for SDK-managed transaction signing and submit.
_Avoid_: unsigned transaction

**Offline signing error**:
A local error indicating that a signing DTO or offline signing state is malformed and cannot safely resume the transaction flow.
_Avoid_: configuration error, endorsement error

## Relationships

- **Transaction targeting** has exactly three modes: gateway default, single-peer, and endorsing-peers.
- Gateway default **Transaction targeting** uses the **Gateway path**.
- Single-peer **Transaction targeting** uses the **Single-peer path**.
- Endorsing-peers **Transaction targeting** uses the **Explicit endorsement path**.
- The **Direct endorsement path** includes the **Single-peer path** and **Explicit endorsement path**.
- Gateway default **Transaction targeting** is the initial transaction state and is not exposed as a public reset API.
- Single-peer **Transaction targeting** uses the **SinglePeer API**.
- Endorsing-peers **Transaction targeting** uses the **EndorsingPeers API**.
- **Proposal creator identity** is independent of **Transaction targeting** and may be supplied for gateway default, single-peer, or endorsing-peers proposal signing.
- **Transaction targeting** is last-call-wins: setting a targeting mode replaces any previous targeting mode on the same transaction.
- **Transaction targeting** is represented as one value object with semantic operations, not as multiple sibling fields inspected across operation code.
- **Transaction targeting** owns only targeting intent and invariants; discovery, peer selection, failover, and Fabric peer adaptation remain separate concerns.
- **Transaction targeting** is an internal model; the public developer API remains the readable **SinglePeer API** and **EndorsingPeers API**.
- The internal **Transaction targeting** model is implemented in both Node and Go SDKs.
- The **Single-peer path** is the primary reason Fabric Bridge SDK exists.
- The **Single-peer path** sends each proposal attempt to exactly one discovered peer.
- The **Explicit endorsement path** sends a proposal to every selected discovered peer.
- The **Direct endorsement path** always uses **Fabric service discovery** before selecting or validating endorsement peers.
- The **Discovery seed** is only used to obtain discovered peers and does not override **Transaction targeting**.
- The **Gateway endpoint** and **Discovery seed** are separate configuration roles, even when they point to the same peer endpoint.
- Gateway default **Transaction targeting** uses **Gateway submit**.
- The **Direct endorsement path** uses **Orderer submit**.
- A **Single-peer transaction** uses **Discovered peer selection** in the first new design.
- A **Single-peer transaction** can be an evaluation or a submit operation.
- The **SinglePeer API** expresses automatic single-peer choice and is distinct from **Explicit peer targeting**.
- **Explicit peer targeting** preserves the developer-provided peer set and does not choose among candidates.
- The **EndorsingPeers API** expresses **Explicit peer targeting** and sends the proposal to every named peer.
- The **EndorsingPeers API** requires at least one peer; an empty peer set is invalid **Transaction targeting**.
- **Offline transaction signing** is distinct from submit-async behavior; submit-async means the transaction has been sent without waiting for commit.
- **Offline transaction signing** is exposed through **Bridge signable message** types instead of leaking Gateway or legacy SDK transaction types.
- External signers sign the **Message digest**, while full message bytes remain available for persistence, transport, and signer implementations that require them.
- A **Signing request** uses canonical Fabric bytes as the source of truth and does not duplicate data already present in the Fabric message.
- A **Proposal signing request** does not duplicate the **Proposal creator identity** in the wire format.
- A **Proposal creator identity** is represented to the SDK by the creator MSP ID and serialized X.509 credential material, not by an application-specific identity provider.
- Go and Node SDKs expose explicit inspection of the **Proposal creator identity** from a **Proposal signing request** or bridge signable proposal object.
- A transaction ID for an externally signed proposal is derived from the proposal nonce and **Proposal creator identity**, not from the **Bridge identity**.
- A **Signing request** may include operational metadata that is not present in the Fabric message but is required to resume the same bridge flow.
- Node and Go expose the same offline signing concepts but do not share a cross-runtime signing DTO contract.
- A proposal **Signing request** includes an **Endorsement routing snapshot**.
- An **Endorsement routing snapshot** stores only routing mode and canonical peer endpoints; channel, chaincode, transaction identity, and creator identity are read from canonical Fabric bytes.
- An **Endorsement routing snapshot** stores resolved peer endpoints, not candidate names or aliases.
- An **Endorsement routing snapshot** is an immutable record of the exact **Peer endpoint identity** values selected when the proposal **Signing request** was created.
- Peer resolution compares exact **Peer endpoint identity** values and never uses substring matching.
- **Peer endpoint identity** normalization is deterministic: existing `grpc://` or `grpcs://` schemes are preserved, missing schemes are filled from TLS mode, hosts are lowercased, and ports are required.
- **Peer endpoint identity** values never include paths, query strings, fragments, DNS resolution, aliases, or partial peer names.
- When discovery is available, the canonical **Peer endpoint identity** stored in an **Endorsement routing snapshot** is taken from the discovered peer endpoint, not from developer input alone.
- TLS mode is only a fallback for normalizing developer input before discovery has identified the peer.
- Invalid **Peer endpoint identity** format is local configuration failure; a valid endpoint absent from discovery is a peer-not-found failure.
- During offline resume, malformed **Peer endpoint identity** values in an **Endorsement routing snapshot** are **Offline signing error** values, while valid values absent from current channel discovery are peer-not-found failures.
- **EndorsingPeers API** deduplicates normalized **Peer endpoint identity** values while preserving developer order.
- An **Endorsement routing snapshot** never stores duplicate **Peer endpoint identity** values.
- Duplicate developer input for the same **Peer endpoint identity** is deduplicated silently, but duplicate discovered peers with the same canonical **Peer endpoint identity** are ambiguous discovery and fail before endorsement.
- **Transaction targeting** can only select peers discovered for the channel; valid endpoints absent from channel discovery are never used for endorsement.
- **Explicit peer targeting** fails the whole operation when any requested **Peer endpoint identity** is absent from channel discovery.
- Offline resume revalidates the **Endorsement routing snapshot** against current channel discovery and never substitutes a different peer automatically.
- Offline resume fails locally when any **Peer endpoint identity** recorded in the **Endorsement routing snapshot** is absent from current channel discovery.
- Offline **Single-peer transaction** snapshots store exactly the selected **Peer endpoint identity**, not the full eligible peer set.
- **Endorsement routing snapshot** appears only on proposal **Signing request** values because peer routing ends at endorsement.
- An **Endorsement routing snapshot** selects endorsement targets but does not replace the bridge network, TLS, discovery, or orderer configuration required to resume the flow.
- The **Signing request wire format** encodes `bytes`, **Message digest**, and signatures as base64.
- The SDK validates that a signed-message digest matches the canonical Fabric bytes but does not verify the external signature cryptographically before sending to Fabric.
- Signed-message DTOs retain the **Message digest** from the **Signing request**, and the bridge validates it against the canonical Fabric bytes before resuming.
- Malformed signing DTOs fail with an **Offline signing error** before any Fabric network call is attempted.
- Missing **Proposal creator identity** while building a proposal **Signing request** is local configuration failure, not an **Offline signing error**.
- The bridge performs mandatory structural validation of signed proposal DTOs and treats cryptographic verification of the external proposal signature as optional application policy.
- A configured transaction is the factory for the proposal **Signing request** so that **Transaction targeting** and transient data are captured before signing.
- The configured transaction also owns any caller-supplied **Proposal creator identity** used to build a proposal **Signing request**.
- Building a proposal **Signing request** requires an explicit **Proposal creator identity**; the SDK does not silently use the **Bridge identity** as the proposal creator for offline signing.
- The explicit **Proposal creator identity** requirement applies to offline proposal signing, not to online submit or evaluate flows that use the **Bridge identity** normally.
- Developers do not manually construct **Proposal signing request** values; the SDK builds the proposal and exposes the **Message digest** to be signed.
- The bridge root object rehydrates signed-message DTOs into **Offline signing flow object** values within the same runtime.
- A proposal **Signing request** captures the effective peer set for one endorsement attempt.
- **Offline transaction signing** on the **Single-peer path** does not perform **Single-peer failover**; endorsement failure for the snapshotted peer is terminal for that signed proposal.
- **Signing request** and signed-message DTOs are portable data, while **Offline signing flow object** types own runtime behavior.
- A **Signing request** is currently always a **Proposal signing request**.
- A signed proposal produces an **Endorsed transaction**, and the SDK signs the final transaction with the bridge identity before submit.
- **Offline transaction signing** currently signs only the proposal externally; final transaction signing uses the bridge identity loaded in the SDK.
- The **External proposal signer** signs the proposal **Message digest** for the **Proposal creator identity**.
- The **External proposal signer** is not used for bridge-owned operations such as discovery, event handling, submit, or commit tracking.
- The **Proposal creator identity** and the **Bridge identity** may differ.
- The **Bridge identity** is signed exclusively through the SDK-configured bridge signer, not through private key material in bridge configuration.
- Transport-layer TLS client key material is distinct from **Bridge identity** signing and may still be configured for mTLS.
- The **Bridge identity** is expected to have an SDK-configured bridge signer for submit and commit tracking even when the **Proposal creator identity** is externally signed.
- Fabric Bridge SDK models **Proposal creator identity** and **External proposal signer** generically; application-specific identity providers are outside the SDK language.
- The identity that signs the proposal and the identity that submits to the orderer may differ; the proposal signature is bound to the **Proposal creator identity**.
- The bridge accepts a signed proposal whose **Proposal creator identity** differs from the loaded bridge identity.
- Local policy that restricts accepted **Proposal creator identity** values is optional application policy, not default bridge behavior.
- **Offline transaction signing** begins when a transaction creates a proposal **Signing request**; it is not enabled by global bridge state.
- **Offline transaction signing** supports evaluation as a proposal-only flow that ends after a signed proposal is evaluated.
- Peer-targeted offline proposal construction and endorsement do not require the **Bridge identity** private key; the externally supplied proposal signature is used for endorsement.
- Commit tracking after offline submit uses the bridge identity and signer through the existing commit-waiting behavior.
- The **SinglePeer API** does not accept peer lists in the first new design.
- Offline signing API methods use PascalCase in both Node and Go.
- Node and Go keep cohesive API names, but each runtime follows its own error-handling idioms.
- Node reports SDK operation errors through `better-result`; Go reports SDK errors through returned `error` values.
- In Go, **SinglePeer API** and **EndorsingPeers API** are mutable setters that return only `error`, not fluent builders.
- In Node, **SinglePeer API** and **EndorsingPeers API** return `better-result` values when local targeting validation can fail.
- In Node, a successful targeting setter returns the same mutable transaction builder inside `Result.ok`.
- The **SinglePeer API** always validates eligible peers through discovery.
- The default **Peer selection policy** is round-robin scoped to the SDK instance and the effective peer set.
- Online **Single-peer failover** is enabled by design and is not exposed as a public toggle in the first new design.
- The first new design uses round-robin as the only **Peer selection policy** for the **Single-peer path**.
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

> **Dev:** "Can I pass three peers to `UseEndorsingPeers`?"
> **Domain expert:** "Yes, that is **Explicit peer targeting**: the SDK sends the proposal to all three discovered peers. `UseSinglePeer` is different: the SDK chooses exactly one discovered peer."

## Flagged Ambiguities

- "single peer" was used both for automatic single-peer choice and caller-provided peer lists; resolved: **Single-peer path** chooses one discovered peer, while **Explicit endorsement path** sends to every caller-provided peer.
