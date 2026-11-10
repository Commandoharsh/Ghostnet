# Transport Abstraction Requirements

- Define a common adapter contract for initialize/start/stop/send/receive/status.
- Expose capabilities and transport identity.
- Registry rejects duplicate IDs and supports lookup/list/removal.
- Manager isolates adapter failures and can send through selected available adapters.
- Simulator supports testable send/receive behavior and explicit simulated status.
- Message payloads use Uint8Array at the transport boundary.
- Tests cover registration, lifecycle, send/receive, and failure isolation.
- No physical radio implementation is claimed in this milestone.
