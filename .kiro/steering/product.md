---
inclusion: always
---
# GhostNet Product Definition

GhostNet is an offline-first, resilient emergency communication platform. It is designed to exchange emergency and general messages when internet or cellular service is unavailable, using a combination of local networks, radio links, gateways, and store-and-forward relays.

Core capabilities:
- Peer and multi-hop messaging foundations
- Offline composition and persistent browser outbox
- Transport-independent networking
- Emergency triage assistance and multilingual support (future milestones)
- Location sharing (future milestone)
- Delivery acknowledgements, expiry, deduplication, and hop limits

Operating modes:
1. Local offline: devices communicate over an available local network without internet.
2. Mesh: nodes relay messages for other nodes.
3. Gateway: a gateway bridges distinct transports or network segments.
4. Store-and-forward: messages are retained until a suitable route is available.
5. Internet-assisted: internet may be used, but is not mandatory.

Never present simulated nodes or links as physical connectivity. AI classifications are advisory and require human verification for critical cases.
