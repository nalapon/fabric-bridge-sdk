# Use orderer submit for the direct endorsement path

The **Direct endorsement path** will submit endorsed transactions directly to the orderer instead of using Gateway submit. This applies to online and offline transactions that use the **Single-peer path** or **Explicit endorsement path**. This keeps Gateway routing and direct endorsement routing conceptually separate: the **Gateway path** uses Gateway endorsement and **Gateway submit**, while direct endorsement routes use direct peer endorsement and **Orderer submit**.

## Consequences

- The bridge-owned peer adapter must retain a minimal orderer submit implementation.
- Direct endorsement evaluation, proposal creation, and endorsement do not require orderer configuration, but direct endorsement submit requires an orderer endpoint.
- Offline peer-targeted submit must not resume through Gateway submit after direct peer endorsement.
- The terms **Gateway submit** and **Orderer submit** should be used instead of "direct submit", which is ambiguous in this codebase.
