---
inclusion: always
---
# GhostNet Architecture

Use a modular monolith for the initial application and preserve clear boundaries:

- UI: Next.js/React pages and components.
- Messaging: message schema, validation, local outbox, API client.
- Network: transport contracts, registry, manager, routing and simulator.
- Adapters: transport-specific code only; core messaging must not import hardware drivers.
- Future device agent: native access to serial, BLE, Wi-Fi Direct, and radio hardware.
- API: versionable HTTP/WebSocket interfaces.

Messages must carry stable IDs, source/destination, creation and expiry timestamps, priority, hop count, maximum hops, and payload. Low-bandwidth transports require compact encoding and bounded packet sizes.

Do not duplicate existing implementations. Inspect the repository before changing it. Keep the existing dashboard and message center functional. A local web app cannot independently access all radio hardware; use a native device agent or gateway where required.

The web application is strictly an interface, not the network. GhostNet must be capable of starting, creating messages, discovering reachable peers, transmitting messages, receiving messages and storing messages without an internet connection or cloud dependency. Networking engine logic must remain independent of Next.js, React, or browser APIs.
