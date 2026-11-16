# GhostNet — Phase 4 Audit: Mesh Networking Engine

**Date:** 2026-11-16  
**Milestone:** Phase 4 — Mesh Networking Engine  
**Preceding Milestone:** Phase 3 — Transport Abstraction & Engine Hardening  

---

## 1. Verification Results

All three quality gates passed with zero errors.

| Gate | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` (`tsc --noEmit`) | **PASSED** — 0 errors |
| Test suite | `npm test` | **PASSED** — 99/99 tests, 0 failures |
| Production build | `npm run build` | **PASSED** — 6 routes compiled cleanly |

### Test suite breakdown

| File | Tests | Status |
|---|---|---|
| `tests/mesh/mesh-engine.test.ts` | 39 | ✔ All pass |
| `tests/offline/outbox.test.ts` | 17 | ✔ All pass (no regression) |
| `tests/messaging/deduplication.test.ts` | 5 | ✔ All pass (no regression) |
| `tests/security/security.test.ts` | 20 | ✔ All pass (no regression) |
| `tests/transports/codec.test.ts` | 7 | ✔ All pass (no regression) |
| `tests/transports/manager.test.ts` | 5 | ✔ All pass (no regression) |
| `tests/transports/registry.test.ts` | 5 | ✔ All pass (no regression) |
| `tests/transports/simulator.test.ts` | 6 | ✔ All pass (no regression) |

---

## 2. Files Added

All new files are under `src/lib/network/`. No existing file was deleted or structurally changed. The two engine source files updated (`mesh-engine.ts`) are entirely new Phase 4 code.

| File | Purpose |
|---|---|
| `src/lib/network/mesh-types.ts` | All Phase 4 type definitions: `NodeIdentity`, `NeighborEntry`, `RouteEntry`, `RouteMetric`, `MessageStore`, `AckRecord`, `AckPayload`, `PendingAck`, `RetryRecord`, `MeshEngineConfig`, `ForwardDecision` |
| `src/lib/network/neighbor-table.ts` | `NeighborTable` — TTL-based neighbor tracking with add/update/expire/list/prune |
| `src/lib/network/routing-table.ts` | `RoutingTable` — multi-route table with hop-count + signal-quality selection, failure marking, alternate route selection |
| `src/lib/network/ack-tracker.ts` | `AckTracker` — pending ACK registry with timeout timers, duplicate ACK suppression, cancel-without-callback |
| `src/lib/network/retry-manager.ts` | `RetryManager` — bounded retry queue with configurable limits, interval, and exhaustion callback |
| `src/lib/network/message-store.ts` | `InMemoryMessageStore` — Phase 4 implementation of the `MessageStore` interface (idempotent put, get, purge) |
| `src/lib/network/mesh-engine.ts` | `MeshEngine` — top-level orchestrator; wraps `TransportManager`; implements forwarding, ACK, retry, neighbor and route management |
| `tests/mesh/mesh-engine.test.ts` | 39 tests covering all required Phase 4 scenarios plus unit tests for each sub-component |

---

## 3. Architecture Changes

### What was added

**`MeshEngine`** wraps the existing `TransportManager`. It does not replace it. The Phase 3 transport stack (`TransportRegistry`, `TransportManager`, `SimulatorAdapter`, `DeduplicationCache`, `codec`) is fully preserved and reused.

```
MeshEngine
  ├── TransportManager   (Phase 3 — unchanged)
  │     └── TransportRegistry + adapters
  ├── NeighborTable      (Phase 4)
  ├── RoutingTable       (Phase 4)
  ├── AckTracker         (Phase 4)
  ├── RetryManager       (Phase 4)
  ├── DeduplicationCache (Phase 3, reused)
  └── MessageStore       (Phase 4 interface / in-memory impl)
```

**Inbound message path:**
1. `TransportManager.onMessage` delivers raw `TransportMessage` to `MeshEngine.handleInbound`.
2. `DeduplicationCache` suppresses already-seen message IDs.
3. ACK control messages (payload type `"GN_ACK_V1"`) are diverted to `handleAck`.
4. Data messages: source node is announced as a neighbor; `forwardDecision` determines deliver/forward/drop.
5. Delivery: stored in `MessageStore`, emitted to `onDelivery` listeners, ACK sent back to source.
6. Forward: hop count incremented, sent via `TransportManager.send`; on failure the route is marked inactive and an alternate is attempted.

**Outbound send path:**
1. `MeshEngine.send` validates expiry and hop count.
2. `routeAndSend` selects the best active route via `RoutingTable.bestRoute`; falls back to broadcast when no route is known.
3. On transport rejection, the route is marked failed and `onRouteFailure` listeners are notified immediately.
4. When `requestAck: true`, an ACK expectation is registered in `AckTracker` regardless of whether the initial send succeeded (enabling the retry path even on immediate failure).
5. ACK timeout triggers `RetryManager.enqueue`; retries use `RoutingTable.alternativeRoute`.

**ACK control messages** are plain `TransportMessage` objects with a JSON payload discriminated by `type: "GN_ACK_V1"`. They travel through the same codec and transport stack as data messages — no new packet type or codec change was required.

### What was not changed

- `types.ts`, `codec.ts`, `registry.ts`, `manager.ts`, `deduplication.ts`, `simulator.ts`, `adapters/simulator-adapter.ts` — all unchanged.
- `app/` pages, `app/api/` routes — unchanged.
- `src/lib/offline/outbox.ts` — unchanged.

---

## 4. Implemented Functionality

### Neighbor Discovery
- `NeighborTable` stores `NeighborEntry` records with node ID, adapter ID, transport kind, signal quality, and ISO 8601 last-seen timestamp.
- Entries expire after a configurable TTL (default 60 s). Expiry is lazy (checked on `get`/`list`) plus an explicit `prune()` method.
- `MeshEngine.announceNeighbor()` is the injection point for discovery events. Currently called manually and by `handleInbound` when a data message is received from an unknown source.
- `MeshEngine.expireNeighbor()` removes a neighbor and marks all routes through it as inactive.
- Simulated discovery only. Physical beaconing (mDNS, BLE advertisement, LoRa beacon frame) is not implemented.

### Routing Engine
- `RoutingTable` maintains multiple `RouteEntry` records per destination (one per possible next hop).
- Best route selection: fewest hops first; signal quality as tiebreaker.
- `markFailed` / `markRecovered` — routes survive failures without full rediscovery.
- `alternativeRoute(dest, excludeNextHop)` — fallback selection without the failed next hop.
- Routes are populated manually (`upsert`) or automatically when a neighbor is announced (direct 1-hop route).

### Packet Forwarding
- `MeshEngine.forwardDecision()` — pure function; testable without I/O. Returns `deliver | forward | drop`.
- Hop count incremented on each forward hop.
- Duplicate suppression via `DeduplicationCache` (Phase 3, reused).
- Expiry checked before every forward.
- Hop limit checked: `hopCount + 1 >= maxHops` triggers drop.
- Messages addressed to `undefined` / `"broadcast"` are always delivered locally.
- Forward failure on one adapter is isolated; alternative route attempted before emitting a route failure event.

### Acknowledgements
- `AckTracker` correlates received ACKs with pending entries by original message ID.
- Duplicate ACKs suppressed.
- ACK timeout fires via `setTimeout`; callback is `onAckTimeout`.
- `cancel()` removes pending entry without firing callbacks (used on retry exhaustion).
- ACK messages are sent back to the source when a unicast message is delivered to `identity.nodeId`.

### Retry and Recovery
- `RetryManager` maintains a bounded queue (default 200 entries).
- Per-message configurable `maxAttempts` and `retryIntervalMs`.
- Internal `setInterval` tick processes due records.
- Expired messages are dropped from the retry queue silently.
- On exhaustion: `AckTracker.cancel()` called, `onRouteFailure` emitted.

### Storage and Identity Interfaces
- `MessageStore` interface defined in `mesh-types.ts`.
- `InMemoryMessageStore` implementation: idempotent `put`, `get`, `has`, `purgeExpiredBefore`.
- `NodeIdentity` interface: `nodeId` (string), optional `label`.
- **No cryptographic authentication.** `nodeId` is a plain string with no signature verification. Phase 11 will add Ed25519 identity and HMAC integrity.

---

## 5. New Tests and Results

### Test categories

**NeighborTable (5 tests)**  
Add/retrieve, last-seen refresh, TTL expiry, prune count, manual remove.

**RoutingTable (6 tests)**  
Upsert and select, fewest-hops wins, signal-quality tiebreak, failed route excluded, alternate route skips excluded hop, recovery restores route.

**AckTracker (4 tests)**  
Expect+receive resolves entry, timeout fires when no ACK, duplicate ACK suppressed, cancel without callback.

**RetryManager (4 tests)**  
Tick triggers attempt, exhaustion fires callback, success removes record, bounded queue refuses excess.

**InMemoryMessageStore (3 tests)**  
Put+has, idempotent put, purgeExpiredBefore.

**MeshEngine integration (17 tests)**

| # | Scenario | Result |
|---|---|---|
| 1 | Three-node forwarding A → B → C | ✔ |
| 2 | Four-node alternate route — primary failed | ✔ |
| 3 | Neighbor expiration | ✔ |
| 4 | Route failure detected | ✔ |
| 5 | Alternative route recovery | ✔ |
| 6 | ACK delivered from C to A | ✔ |
| 7 | ACK timeout fires | ✔ |
| 8 | Retry exhaustion → route failure | ✔ |
| 9 | Duplicate message suppressed | ✔ |
| 10 | Maximum hop enforcement | ✔ |
| 11 | Expired packet rejected on send | ✔ |
| 11b | Expired inbound packet dropped by decision | ✔ |
| 12 | Adapter failure isolation (broadcast) | ✔ |
| 12b | Single stopped-adapter send rejected | ✔ |
| — | Deliver-to-self decision | ✔ |
| — | Broadcast decision | ✔ |
| — | No-route drop decision | ✔ |

---

## 6. Simulated vs Physically Verified Capabilities

### Simulated only
All networking in Phase 4 operates through in-process `SimulatorAdapter` virtual peer links. No physical hardware is involved.

| Capability | Status |
|---|---|
| Multi-hop message forwarding (A→B→C) | Simulated — in-process `SimulatorAdapter` peer links |
| Neighbor discovery | Simulated — `announceNeighbor()` called manually or on receipt |
| Route selection and failover | Implemented and tested in-process |
| ACK round-trip | Simulated — both nodes in the same process |
| Retry on timeout | Implemented and tested with short in-process timers |
| Duplicate suppression | Implemented and tested |

### Not yet implemented
- Physical LoRa, Wi-Fi Direct, Bluetooth LE, or Ethernet adapters (Phase 6).
- Automatic neighbor beaconing / heartbeat protocol.
- Multi-device communication across separate physical machines (requires Phase 6 socket adapter).
- Persistent message store (SQLite) — Phase 12.
- Cryptographic node identity and packet signing — Phase 11.
- Packet fragmentation for low-MTU transports — Phase 6.
- Store-and-forward with disk persistence across restarts — Phase 5.

---

## 7. Remaining Limitations

1. **No automatic neighbor discovery.** Nodes must call `announceNeighbor()` manually or receive a message from a peer (which triggers an implicit announcement). A periodic beacon/heartbeat frame is not yet implemented.

2. **Route population is manual.** `RoutingTable.upsert()` must be called explicitly for multi-hop routes. Dynamic route propagation (distance-vector or link-state) is not implemented.

3. **ACK messages add an extra message hop.** Each unicast delivery generates a return ACK, doubling traffic on the return path. For high-volume or low-bandwidth transports (LoRa) this will need selective ACKing.

4. **In-memory state only.** The routing table, neighbor table, ACK tracker, and retry queue are all lost on process restart. Phase 5 (store-and-forward) and Phase 12 (SQLite backend) will address this.

5. **`NodeIdentity.nodeId` is unauthenticated.** Any node can claim any ID. Phase 11 adds Ed25519 key pairs and HMAC integrity.

6. **Retry enqueues even on initially-failed sends.** When an adapter is stopped before `send()` is called, the ACK expectation is registered and the timeout fires, triggering the retry path. This is correct behavior for resilience but means a small timer overhead for messages sent to unreachable destinations.

7. **`MeshEngine` accesses `manager["registry"]` directly.** `TransportManager.registry` is private. This is currently accessed via bracket notation. A future refactor should expose a `getAdapter(id)` method on `TransportManager` to remove the internal access.

---

## 8. Security Considerations

- **No authentication.** `sourceNodeId` is trusted as supplied. A malicious node can impersonate any identity. Phase 11 remediation: Ed25519 key pairs, signed envelopes, enrollment protocol.
- **No encryption.** Message payloads travel in plaintext UTF-8 through every relay hop. Phase 11 remediation: symmetric session encryption after key exchange.
- **ACK messages are unauthenticated.** A rogue node can send a spoofed ACK to cancel a legitimate retry. Impact: message silently not delivered. Phase 11 remediation: HMAC on ACK payload.
- **Replay protection.** `DeduplicationCache` (Phase 3) suppresses replayed message IDs within its TTL window. The window is bounded by `defaultTtlMs` (24 hours by default) and cache capacity.
- **Hop amplification.** `maxHops` is validated (1–32) by the Phase 3 codec. The mesh engine enforces this before forwarding.
- **Resource bounds.** `NeighborTable`, `RoutingTable`, `AckTracker`, and `RetryManager` are all bounded. The retry queue defaults to 200 entries; the deduplication cache to 10 000 entries.
- **Advisory classification.** Emergency text classification (`classifyEmergencyText`) is heuristic keyword matching. It is advisory, requires human review for all critical cases, and is never used to silently discard a message.
- **This prototype is not security-audited or safety-certified** for field deployment.

---

## 9. Phase 5 Readiness

Phase 4 is complete. The mesh engine provides the routing and forwarding foundation needed for Phase 5 (store-and-forward with persistent queues, congestion control, and retry scheduling across restarts).

Immediate Phase 5 prerequisites that are now satisfied:
- Transport-independent `MessageStore` interface defined and injectable.
- `RetryManager` is modular and already integrates with the routing table.
- `MeshEngine` event API (`onDelivery`, `onRouteFailure`, `onAckTimeout`) provides the hooks needed for a persistent queue manager.
