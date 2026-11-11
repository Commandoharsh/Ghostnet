# GhostNet — Complete Project Roadmap
## Master Development Plan: Offline-First Communication

**Project:** GhostNet – AI-Powered, Radio-Independent Emergency Communication Network  
**Development Environment:** Kiro  
**Frontend:** React / Next.js + TypeScript (Local Client / PWA)  
**Core Engine:** Autonomous TypeScript / Python Engine (Framework-Independent)  
**Database:** SQLite / Browser IndexedDB  
**AI:** Scikit-learn / Transformers + Local LLM (Ollama)  
**Networking:** LoRa, Wi-Fi, Wi-Fi Direct, Bluetooth LE, Ethernet, Simulator  
**Mapping:** OpenStreetMap  

---

## 1. Project Vision & Core Principles

GhostNet provides reliable communication during natural disasters, infrastructure failures, internet outages, and situations where conventional cellular networks are unavailable.

> **The Core Architectural Axiom:**  
> The web application is the local user interface. It is **not** the network itself.  
> The networking engine moves messages between devices without relying on the internet or remote servers.  
> The transport adapters carry those messages over physical or simulated radio links (LoRa, Wi-Fi, BLE, Ethernet).

### Primary Objectives
1. **Offline-First Messaging:** Interface loads and queues messages locally with zero internet access.
2. **Radio-Independent Communication:** Common adapter interface abstracts hardware details.
3. **Local Mesh Networking:** Multi-node peer links without central coordinators.
4. **Multi-Hop Forwarding:** Relays messages across intermediate nodes while preventing loops.
5. **Store-and-Forward Delivery:** Tolerates temporary node disconnections using persistent queues.
6. **AI-Assisted Emergency Triage:** Advisory severity scoring and categorization (medical, fire, rescue).
7. **Emergency Location Sharing:** OpenStreetMap integration and coordinate broadcasting.
8. **Resilient Operation:** Fully air-gapped functionality tested with external network interfaces disabled.

---

## 2. 15-Phase Development Roadmap

| Phase | Milestone | Focus Area | Status |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **M1: Foundation** | Project setup, TypeScript strict mode, steering specs, architecture standards | **Completed** |
| **Phase 2** | **M2: Messaging** | Local dashboard, IndexedDB outbox, offline message creation, REST bridge | **Completed** |
| **Phase 3** | **M3: Transport Abstraction** | Transport contracts, lifecycle, registry, simulator peer links, versioned packet envelope, unit test suite | **Completed** |
| **Phase 4** | **M4: Mesh Networking** | Node discovery (`PeerDiscovery`), topology tracking, direct delivery, multi-hop routing | Next Priority |
| **Phase 5** | **M5: Store-and-Forward** | Persistent node queues, retry scheduling, congestion control, disconnections | Planned |
| **Phase 6** | **M6: Hardware Integrations** | Local Wi-Fi socket adapter, ESP32 / Raspberry Pi gateway bridge, LoRa (SX1262), BLE | Planned |
| **Phase 7** | **M7: Intelligent Routing** | Link quality evaluation, adaptive transport selection, priority routing | Planned |
| **Phase 8** | **M8: AI Emergency Triage** | Validated local triage model (Scikit-learn, Transformers, Ollama) | Planned |
| **Phase 9** | **M9: Multilingual Translation** | Offline local translation models, language detection, original preservation | Planned |
| **Phase 10** | **M10: Emergency Location** | OpenStreetMap integration, GPS coordinate capture, last-known locations | Planned |
| **Phase 11** | **M11: Security & Identity** | Public/private key identity, envelope encryption, HMAC integrity, replay guards | Planned |
| **Phase 12** | **M12: Backend Infrastructure** | Standalone Python/FastAPI daemon, SQLite persistence, WebSocket events | Planned |
| **Phase 13** | **M13: Command Center** | Advanced topology maps, responder analytics, incident heatmaps | Planned |
| **Phase 14** | **M14: Validation** | Multi-device LAN testing, radio field trials, congestion & recovery tests | Planned |
| **Phase 15** | **M15: Release** | Packaging for field deployment, documentation, disaster responder onboarding | Planned |

---

## 3. End-to-End Message Lifecycle

```
[1. User Composes Message]
       │
       ▼
[2. Local Storage] ──> IndexedDB outbox persists message with unique UUID & TTL
       │
       ▼
[3. Advisory Triage] ──> Local heuristics / AI model flags category (Medical/Fire/Rescue)
       │
       ▼
[4. Transport Selection] ──> Manager selects ready, compatible transport adapter
       │
       ▼
[5. Packet Framing] ──> Codec packages binary envelope (Magic 0x474E, Version 1, TTL, Hop Limit)
       │
       ▼
[6. Multi-Hop Forwarding] ──> Relayed between nodes; loop prevention & duplicate cache enforced
       │
       ▼
[7. Destination Delivery] ──> Destination node decodes envelope and records receipt
       │
       ▼
[8. Acknowledgment Sync] ──> Delivery state updated to "acknowledged" across the mesh
```

---

## 4. Phase 3 Definition of Done Verification

- [x] External CDN runtime dependencies removed from UI shell (system fonts).
- [x] Transport contracts independent of Next.js, React, or browser globals.
- [x] Adapters support granular lifecycle management (`initialize`, `start`, `stop`, `getStatus`).
- [x] TransportManager supports inbound message dispatching and outgoing broadcasts.
- [x] Protocol envelope codec enforces byte-level limits, protocol versioning, and MTU limits.
- [x] SimulatorAdapter supports independent node instances, peer links, and packet loss emulation.
- [x] Expired messages, duplicates, and hop limit violations rejected before transmission.
- [x] Failure of one adapter never crashes other active transports.
- [x] Offline browser outbox in IndexedDB persists queued messages across reloads.
- [x] Automated unit test suite covers codec, registry, simulator, manager, and deduplication.
- [x] Typecheck (`tsc --noEmit`), tests (`npm test`), and production build (`next build`) pass cleanly.
- [x] Single-device air-gapped test verified.
