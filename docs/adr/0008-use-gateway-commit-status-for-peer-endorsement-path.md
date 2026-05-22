# Use Gateway commit status for the direct endorsement path

Transactions endorsed through the **Direct endorsement path** will use the Gateway service for commit tracking when a commit result is needed. This keeps commit tracking signed by the **Bridge identity** while avoiding the legacy SDK event-service stack as part of the bridge-owned peer adapter.

## Consequences

- Direct peer endorsement and direct Fabric service discovery remain outside Gateway endorsement routing.
- The bridge-owned adapter does not need to retain legacy deliver clients, event service registration, or commit event monitor code for normal commit waiting.
