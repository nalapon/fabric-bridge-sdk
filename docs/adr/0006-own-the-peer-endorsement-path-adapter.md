# Own the direct endorsement path adapter

Fabric Bridge SDK will replace the broad `fabric-sdk-go` runtime seam used for the **Direct endorsement path** with a bridge-owned adapter built directly on Fabric protobuf v2 types and gRPC. This is more work than pruning unused legacy SDK folders, but it keeps single-peer, explicit endorsement, offline resume, submit, and commit tracking behind a smaller bridge-specific interface instead of retaining a patched full SDK as a transitive implementation dependency.

## Considered Options

- Keep `fabric-sdk-go` as the runtime adapter and delete unused folders around it.
- Copy a reduced subset of the legacy SDK architecture into the bridge.
- Replace the runtime seam with a bridge-owned adapter for the **Direct endorsement path**.

## Consequences

- The bridge-owned adapter must cover discovery, direct peer endorsement/evaluation, orderer submit, and commit tracking.
- The legacy SDK should be treated as a temporary source of protocol knowledge or small copied routines, not as the long-term module boundary.
- Peer-targeted proposals are built directly with Fabric protobuf v2 types so the bridge owns proposal creator identity, nonce, transaction ID, transient data, and canonical signing bytes for the **Direct endorsement path**.
