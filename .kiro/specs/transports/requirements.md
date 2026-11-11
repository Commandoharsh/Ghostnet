# Transport Abstraction Requirements

- Define a common adapter contract for initialize/start/stop/send/receive/status.
- Expose capabilities and transport identity.
- Registry rejects duplicate IDs and supports lookup/list/removal.
- Manager isolates adapter failures and can send through selected available adapters.
- Simulator supports testable send/receive behavior and explicit simulated status.
- Message payloads use Uint8Array at the transport boundary.
- Implement versioned packet codec (GHOSTNET_V1) with bounds validation before decoding.
- Simulator supports multi-node peer links, configurable drop rates, latency, and loop prevention.
- TransportManager dispatches incoming messages across adapters and supports broadcast with failure isolation.
- Registry tracks adapter health (state, transmission counts, timestamps, and last errors).
- Tests cover registration, lifecycle, send/receive, loop prevention, and failure isolation.
- No physical radio implementation is claimed in this milestone.
