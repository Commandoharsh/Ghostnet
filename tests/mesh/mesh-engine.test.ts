/**
 * Phase 4 — Mesh Networking Engine Tests
 *
 * Covers all required scenarios from the Phase 4 specification:
 *   1.  Three-node forwarding: A → B → C
 *   2.  Four-node alternate routes
 *   3.  Neighbor expiration
 *   4.  Route failure detection
 *   5.  Alternative route recovery
 *   6.  ACK delivery
 *   7.  ACK timeout
 *   8.  Retry exhaustion
 *   9.  Duplicate message suppression
 *   10. Maximum hop enforcement
 *   11. Expired packet rejection
 *   12. Adapter failure isolation
 *
 * Additional unit tests cover the supporting components:
 *   - NeighborTable
 *   - RoutingTable
 *   - AckTracker
 *   - RetryManager
 *   - InMemoryMessageStore
 *
 * All tests use in-memory SimulatorAdapters — no physical hardware, no
 * browser globals, no Next.js or React imports.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SimulatorAdapter } from "../../src/lib/network/adapters/simulator-adapter";
import { TransportRegistry } from "../../src/lib/network/registry";
import { MeshEngine } from "../../src/lib/network/mesh-engine";
import { NeighborTable } from "../../src/lib/network/neighbor-table";
import { RoutingTable } from "../../src/lib/network/routing-table";
import { AckTracker } from "../../src/lib/network/ack-tracker";
import { RetryManager } from "../../src/lib/network/retry-manager";
import { InMemoryMessageStore } from "../../src/lib/network/message-store";
import { encodeTransportPayload } from "../../src/lib/network/codec";
import type { TransportMessage } from "../../src/lib/network/types";
import type { AckRecord } from "../../src/lib/network/mesh-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  id: string,
  src: string,
  dst: string,
  hopCount = 0,
  maxHops = 8,
  expiryOffsetMs = 60_000,
): TransportMessage {
  const now = Date.now();
  return {
    messageId: id,
    sourceNodeId: src,
    destinationNodeId: dst,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiryOffsetMs).toISOString(),
    hopCount,
    maxHops,
    payload: encodeTransportPayload({ body: `payload-${id}` }),
  };
}

/**
 * Build a MeshEngine with a single SimulatorAdapter already registered.
 * Returns the engine and its adapter.
 */
function buildEngine(nodeId: string, adapterId: string): {
  engine: MeshEngine;
  adapter: SimulatorAdapter;
  registry: TransportRegistry;
} {
  const registry = new TransportRegistry();
  const adapter = new SimulatorAdapter(adapterId);
  registry.register(adapter);
  const engine = new MeshEngine(registry, {
    identity: { nodeId },
    neighborTtlMs: 100,   // Short TTL for expiry tests
    ackTimeoutMs: 80,     // Short for ACK timeout tests
    retryIntervalMs: 40,  // Short for retry tests
    maxRetryAttempts: 2,
  });
  return { engine, adapter, registry };
}

/** Wait for a given number of milliseconds. */
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// NeighborTable unit tests
// ---------------------------------------------------------------------------

test("neighbor-table: add and retrieve a neighbor", () => {
  const table = new NeighborTable(60_000);
  table.update("GN-B", "sim-b", "simulator", 0.9);
  const entry = table.get("GN-B");
  assert.ok(entry);
  assert.equal(entry.nodeId, "GN-B");
  assert.equal(entry.adapterId, "sim-b");
  assert.equal(entry.signalQuality, 0.9);
});

test("neighbor-table: refreshing updates lastSeenAt", async () => {
  const table = new NeighborTable(60_000);
  table.update("GN-B", "sim-b", "simulator", 0.5);
  const first = table.get("GN-B")!.lastSeenAt;
  await wait(5);
  table.update("GN-B", "sim-b", "simulator", 0.8);
  const second = table.get("GN-B")!.lastSeenAt;
  assert.ok(second >= first, "lastSeenAt should advance after refresh");
});

test("neighbor-table: expired entries are pruned", async () => {
  const table = new NeighborTable(30); // 30 ms TTL
  table.update("GN-EXP", "sim-exp", "simulator");
  assert.ok(table.has("GN-EXP"));
  await wait(50);
  assert.equal(table.has("GN-EXP"), false, "Entry should be expired");
  assert.equal(table.list().length, 0);
});

test("neighbor-table: prune returns count of removed entries", async () => {
  const table = new NeighborTable(30);
  table.update("GN-P1", "sim-1", "simulator");
  table.update("GN-P2", "sim-2", "simulator");
  await wait(50);
  const removed = table.prune();
  assert.equal(removed, 2);
  assert.equal(table.size(), 0);
});

test("neighbor-table: remove deletes specific entry", () => {
  const table = new NeighborTable(60_000);
  table.update("GN-R", "sim-r", "simulator");
  assert.equal(table.remove("GN-R"), true);
  assert.equal(table.has("GN-R"), false);
  assert.equal(table.remove("GN-R"), false);
});

// ---------------------------------------------------------------------------
// RoutingTable unit tests
// ---------------------------------------------------------------------------

test("routing-table: upsert and best route selection", () => {
  const rt = new RoutingTable();
  rt.upsert("GN-C", "GN-B", "sim-b", {
    hopCount: 2,
    signalQuality: 0.8,
    lastConfirmedAt: new Date().toISOString(),
  });
  const best = rt.bestRoute("GN-C");
  assert.ok(best);
  assert.equal(best.destinationId, "GN-C");
  assert.equal(best.nextHopId, "GN-B");
});

test("routing-table: selects fewest hops when multiple routes exist", () => {
  const rt = new RoutingTable();
  const ts = new Date().toISOString();
  rt.upsert("GN-C", "GN-B", "sim-b", { hopCount: 3, signalQuality: 0.9, lastConfirmedAt: ts });
  rt.upsert("GN-C", "GN-D", "sim-d", { hopCount: 2, signalQuality: 0.6, lastConfirmedAt: ts });
  const best = rt.bestRoute("GN-C");
  assert.equal(best?.nextHopId, "GN-D", "Route with fewer hops should win");
});

test("routing-table: breaks hop ties with signal quality", () => {
  const rt = new RoutingTable();
  const ts = new Date().toISOString();
  rt.upsert("GN-C", "GN-B", "sim-b", { hopCount: 2, signalQuality: 0.6, lastConfirmedAt: ts });
  rt.upsert("GN-C", "GN-D", "sim-d", { hopCount: 2, signalQuality: 0.9, lastConfirmedAt: ts });
  const best = rt.bestRoute("GN-C");
  assert.equal(best?.nextHopId, "GN-D", "Higher signal quality should win tiebreak");
});

test("routing-table: markFailed excludes route from best", () => {
  const rt = new RoutingTable();
  const ts = new Date().toISOString();
  rt.upsert("GN-C", "GN-B", "sim-b", { hopCount: 2, signalQuality: 0.9, lastConfirmedAt: ts });
  rt.markFailed("GN-C", "GN-B");
  assert.equal(rt.bestRoute("GN-C"), undefined, "Failed route should not be selected");
});

test("routing-table: alternativeRoute skips the excluded next hop", () => {
  const rt = new RoutingTable();
  const ts = new Date().toISOString();
  rt.upsert("GN-C", "GN-B", "sim-b", { hopCount: 2, signalQuality: 0.9, lastConfirmedAt: ts });
  rt.upsert("GN-C", "GN-D", "sim-d", { hopCount: 3, signalQuality: 0.7, lastConfirmedAt: ts });
  const alt = rt.alternativeRoute("GN-C", "GN-B");
  assert.equal(alt?.nextHopId, "GN-D");
});

test("routing-table: markRecovered restores route", () => {
  const rt = new RoutingTable();
  const ts = new Date().toISOString();
  rt.upsert("GN-C", "GN-B", "sim-b", { hopCount: 2, signalQuality: 0.9, lastConfirmedAt: ts });
  rt.markFailed("GN-C", "GN-B");
  rt.markRecovered("GN-C", "GN-B");
  assert.ok(rt.bestRoute("GN-C"), "Route should be active after recovery");
});

// ---------------------------------------------------------------------------
// AckTracker unit tests
// ---------------------------------------------------------------------------

test("ack-tracker: expect and receive resolves pending entry", async () => {
  const tracker = new AckTracker();
  let resolved: AckRecord | null = null;
  let timedOut = false;

  tracker.expect({
    messageId: "ack-msg-001",
    destinationId: "GN-B",
    enqueuedAtMs: Date.now(),
    timeoutMs: 200,
    onAck: r => { resolved = r; },
    onTimeout: () => { timedOut = true; },
  });

  const accepted = tracker.receive({
    originalMessageId: "ack-msg-001",
    ackedBy: "GN-B",
    ackedAt: new Date().toISOString(),
  });

  assert.equal(accepted, true);
  assert.ok(resolved, "onAck callback must be called");
  assert.equal((resolved as AckRecord).ackedBy, "GN-B");

  // Wait past timeout to confirm it doesn't fire after receive.
  await wait(250);
  assert.equal(timedOut, false, "onTimeout must not fire after ACK was received");
});

test("ack-tracker: timeout fires when no ACK arrives", async () => {
  const tracker = new AckTracker();
  let timedOut = false;

  tracker.expect({
    messageId: "ack-msg-timeout",
    destinationId: "GN-B",
    enqueuedAtMs: Date.now(),
    timeoutMs: 60,
    onAck: () => {},
    onTimeout: () => { timedOut = true; },
  });

  await wait(120);
  assert.equal(timedOut, true, "onTimeout must fire after the deadline");
  assert.equal(tracker.hasPending("ack-msg-timeout"), false);
});

test("ack-tracker: duplicate ACK is suppressed", () => {
  const tracker = new AckTracker();
  let callCount = 0;

  tracker.expect({
    messageId: "ack-msg-dup",
    destinationId: "GN-B",
    enqueuedAtMs: Date.now(),
    timeoutMs: 500,
    onAck: () => { callCount++; },
    onTimeout: () => {},
  });

  tracker.receive({ originalMessageId: "ack-msg-dup", ackedBy: "GN-B", ackedAt: new Date().toISOString() });
  tracker.receive({ originalMessageId: "ack-msg-dup", ackedBy: "GN-B", ackedAt: new Date().toISOString() });

  assert.equal(callCount, 1, "onAck must only be called once despite duplicate ACK");
});

test("ack-tracker: cancel removes pending entry without firing callbacks", async () => {
  const tracker = new AckTracker();
  let timedOut = false;

  tracker.expect({
    messageId: "ack-cancel",
    destinationId: "GN-B",
    enqueuedAtMs: Date.now(),
    timeoutMs: 60,
    onAck: () => {},
    onTimeout: () => { timedOut = true; },
  });

  tracker.cancel("ack-cancel");
  assert.equal(tracker.hasPending("ack-cancel"), false);

  await wait(120);
  assert.equal(timedOut, false, "onTimeout must not fire after cancel");
});

// ---------------------------------------------------------------------------
// RetryManager unit tests
// ---------------------------------------------------------------------------

test("retry-manager: enqueue and tick triggers retry attempt", async () => {
  const manager = new RetryManager({ maxAttempts: 2, retryIntervalMs: 30 });
  const msg = makeMsg("retry-001", "GN-A", "GN-C");
  manager.enqueue(msg, "sim-a");

  let attempts = 0;
  await wait(50);

  await manager.tick(
    async () => { attempts++; return { accepted: false, reason: "still failing" }; },
    () => {},
  );

  assert.ok(attempts >= 1, "At least one retry attempt must have been made");
});

test("retry-manager: exhausted retries triggers exhausted callback", async () => {
  const manager = new RetryManager({ maxAttempts: 1, retryIntervalMs: 20 });
  const msg = makeMsg("retry-exhaust", "GN-A", "GN-C");
  manager.enqueue(msg, "sim-a");

  let exhausted = false;
  await wait(40);
  await manager.tick(
    async () => ({ accepted: false, reason: "dead link" }),
    () => { exhausted = true; },
  );

  assert.equal(exhausted, true, "Exhausted callback must fire after max attempts");
  assert.equal(manager.has("retry-exhaust"), false, "Record must be removed after exhaustion");
});

test("retry-manager: successful retry removes record", async () => {
  const manager = new RetryManager({ maxAttempts: 3, retryIntervalMs: 20 });
  const msg = makeMsg("retry-success", "GN-A", "GN-C");
  manager.enqueue(msg, "sim-a");

  await wait(40);
  await manager.tick(async () => ({ accepted: true }), () => {});

  assert.equal(manager.has("retry-success"), false, "Successful retry must remove record");
});

test("retry-manager: bounded queue refuses excess entries", () => {
  const manager = new RetryManager({ maxQueueSize: 2 });
  const m1 = makeMsg("rq-1", "GN-A", "GN-C");
  const m2 = makeMsg("rq-2", "GN-A", "GN-C");
  const m3 = makeMsg("rq-3", "GN-A", "GN-C");

  assert.equal(manager.enqueue(m1, "sim-a"), true);
  assert.equal(manager.enqueue(m2, "sim-a"), true);
  assert.equal(manager.enqueue(m3, "sim-a"), false, "Queue full — third entry must be refused");
  assert.equal(manager.size(), 2);
});

// ---------------------------------------------------------------------------
// InMemoryMessageStore unit tests
// ---------------------------------------------------------------------------

test("message-store: put and has", async () => {
  const store = new InMemoryMessageStore();
  await store.put("msg-s1", new Uint8Array([1, 2, 3]), new Date().toISOString());
  assert.equal(await store.has("msg-s1"), true);
  assert.equal(await store.has("msg-s2"), false);
});

test("message-store: put is idempotent", async () => {
  const store = new InMemoryMessageStore();
  const ts = new Date().toISOString();
  await store.put("msg-idem", new Uint8Array([10]), ts);
  await store.put("msg-idem", new Uint8Array([20]), ts); // should be no-op
  const got = await store.get("msg-idem");
  assert.deepEqual(Array.from(got!), [10], "Second put must not overwrite first");
});

test("message-store: purgeExpiredBefore removes old entries", async () => {
  const store = new InMemoryMessageStore();
  const old = new Date(Date.now() - 10_000).toISOString();
  const fresh = new Date().toISOString();
  await store.put("msg-old", new Uint8Array([1]), old);
  await store.put("msg-fresh", new Uint8Array([2]), fresh);

  const cutoff = new Date(Date.now() - 5_000).toISOString();
  const removed = await store.purgeExpiredBefore(cutoff);
  assert.equal(removed, 1);
  assert.equal(await store.has("msg-old"), false);
  assert.equal(await store.has("msg-fresh"), true);
});

// ---------------------------------------------------------------------------
// 1. Three-node forwarding: A → B → C
// ---------------------------------------------------------------------------

test("mesh: three-node forwarding A → B → C", async () => {
  // Topology: A ——sim-ab—— B ——sim-bc—— C
  // A sends to C.  B receives and forwards.  C delivers locally.

  const registryA = new TransportRegistry();
  const registryB = new TransportRegistry();
  const registryC = new TransportRegistry();

  const simAB_A = new SimulatorAdapter("sim-ab-a"); // A's view of the A–B link
  const simAB_B = new SimulatorAdapter("sim-ab-b"); // B's view of the A–B link
  const simBC_B = new SimulatorAdapter("sim-bc-b"); // B's view of the B–C link
  const simBC_C = new SimulatorAdapter("sim-bc-c"); // C's view of the B–C link

  registryA.register(simAB_A);
  registryB.register(simAB_B);
  registryB.register(simBC_B);
  registryC.register(simBC_C);

  // Connect the adapters so messages physically cross between nodes.
  simAB_A.connectPeer(simAB_B);
  simBC_B.connectPeer(simBC_C);

  const engineA = new MeshEngine(registryA, { identity: { nodeId: "GN-A" } });
  const engineB = new MeshEngine(registryB, { identity: { nodeId: "GN-B" } });
  const engineC = new MeshEngine(registryC, { identity: { nodeId: "GN-C" } });

  await engineA.start();
  await engineB.start();
  await engineC.start();

  // Manually announce neighbors to seed the routing tables.
  engineA.announceNeighbor("GN-B", "sim-ab-a");
  engineB.announceNeighbor("GN-A", "sim-ab-b");
  engineB.announceNeighbor("GN-C", "sim-bc-b");
  engineC.announceNeighbor("GN-B", "sim-bc-c");

  // B knows C directly, so give A a 2-hop route to C via B.
  engineA.getRoutingTable().upsert("GN-C", "GN-B", "sim-ab-a", {
    hopCount: 2,
    signalQuality: 0.9,
    lastConfirmedAt: new Date().toISOString(),
  });

  const delivered: TransportMessage[] = [];
  engineC.onDelivery(msg => delivered.push(msg));

  const msg = makeMsg("fwd-abc-001", "GN-A", "GN-C");
  const result = await engineA.send(msg);
  assert.equal(result.accepted, true, "A must accept the outbound message");

  // Allow time for the two async hops to complete.
  await wait(80);

  assert.equal(delivered.length, 1, "C must receive exactly one delivery");
  assert.equal(delivered[0].messageId, "fwd-abc-001");
  assert.equal(delivered[0].sourceNodeId, "GN-A");

  await engineA.stop();
  await engineB.stop();
  await engineC.stop();
});

// ---------------------------------------------------------------------------
// 2. Four-node alternate routes
// ---------------------------------------------------------------------------

test("mesh: four-node alternate route — A → C when primary path via B fails", async () => {
  // Topology:
  //   A ——sim-ab—— B ——sim-bc—— C   (primary path)
  //   A ——sim-ad—— D ——sim-dc—— C   (alternate path)

  const registryA = new TransportRegistry();
  const registryC = new TransportRegistry();

  const simAB = new SimulatorAdapter("sim-ab");
  const simAD = new SimulatorAdapter("sim-ad");
  registryA.register(simAB);
  registryA.register(simAD);

  const simCA = new SimulatorAdapter("sim-ca");
  registryC.register(simCA);

  const engineA = new MeshEngine(registryA, { identity: { nodeId: "GN-A" } });
  const engineC = new MeshEngine(registryC, { identity: { nodeId: "GN-C" } });
  await engineA.start();
  await engineC.start();

  // Install both routes in A's routing table.
  const ts = new Date().toISOString();
  engineA.getRoutingTable().upsert("GN-C", "GN-B", "sim-ab", { hopCount: 2, signalQuality: 0.9, lastConfirmedAt: ts });
  engineA.getRoutingTable().upsert("GN-C", "GN-D", "sim-ad", { hopCount: 2, signalQuality: 0.7, lastConfirmedAt: ts });

  // Connect the alternate path adapter directly to C.
  simAD.connectPeer(simCA);

  const delivered: TransportMessage[] = [];
  engineC.onDelivery(msg => delivered.push(msg));

  // Mark the primary route via B as failed.
  engineA.getRoutingTable().markFailed("GN-C", "GN-B");

  const msg = makeMsg("alt-route-001", "GN-A", "GN-C");
  const result = await engineA.send(msg);
  assert.equal(result.accepted, true, "A must find the alternate route");

  await wait(80);
  assert.equal(delivered.length, 1, "C must receive via alternate path");
  assert.equal(delivered[0].messageId, "alt-route-001");

  await engineA.stop();
  await engineC.stop();
});

// ---------------------------------------------------------------------------
// 3. Neighbor expiration
// ---------------------------------------------------------------------------

test("mesh: neighbor expiration removes stale entry", async () => {
  const { engine, adapter } = buildEngine("GN-A", "sim-a");
  await engine.start();
  // neighborTtlMs is 100ms in buildEngine
  engine.announceNeighbor("GN-B", "sim-a");
  assert.ok(engine.getNeighborTable().has("GN-B"), "Neighbor must be present immediately");

  await wait(200);
  assert.equal(engine.getNeighborTable().has("GN-B"), false, "Neighbor must have expired");

  await engine.stop();
});

// ---------------------------------------------------------------------------
// 4. Route failure detection
// ---------------------------------------------------------------------------

test("mesh: route failure detected when adapter rejects forward", async () => {
  const registry = new TransportRegistry();
  const adapter = new SimulatorAdapter("sim-a");
  registry.register(adapter);

  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });
  await engine.start();

  engine.getRoutingTable().upsert("GN-C", "GN-B", "sim-a", {
    hopCount: 2,
    signalQuality: 0.9,
    lastConfirmedAt: new Date().toISOString(),
  });

  const failures: string[] = [];
  engine.onRouteFailure((msgId) => failures.push(msgId));

  // Stop the adapter to cause a forwarding failure.
  await adapter.stop();

  const msg = makeMsg("fail-detect-001", "GN-A", "GN-C");
  // routeAndSend will find the route, call manager.send (which fails because
  // the adapter is stopped), then mark the route failed and emit routeFailure.
  await engine.send(msg);

  // Route should be marked failed immediately (synchronous path in routeAndSend).
  const route = engine.getRoutingTable().bestRoute("GN-C");
  assert.equal(route, undefined, "Failed route must not be selected");

  // The route failure listener is called synchronously within routeAndSend.
  assert.equal(failures.length, 1, "Route failure event must be emitted");
  assert.equal(failures[0], "fail-detect-001");

  await engine.stop();
});

// ---------------------------------------------------------------------------
// 5. Alternative route recovery
// ---------------------------------------------------------------------------

test("mesh: alternative route recovery after primary fails", async () => {
  const registry = new TransportRegistry();
  const badAdapter = new SimulatorAdapter("sim-bad");
  const goodAdapter = new SimulatorAdapter("sim-good");
  registry.register(badAdapter);
  registry.register(goodAdapter);

  const registryC = new TransportRegistry();
  const simC = new SimulatorAdapter("sim-c");
  registryC.register(simC);

  goodAdapter.connectPeer(simC);

  const engineA = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });
  const engineC = new MeshEngine(registryC, { identity: { nodeId: "GN-C" } });
  await engineA.start();
  await engineC.start();

  const ts = new Date().toISOString();
  engineA.getRoutingTable().upsert("GN-C", "GN-B", "sim-bad", { hopCount: 2, signalQuality: 0.9, lastConfirmedAt: ts });
  engineA.getRoutingTable().upsert("GN-C", "GN-D", "sim-good", { hopCount: 3, signalQuality: 0.7, lastConfirmedAt: ts });

  // Fail the primary route.
  engineA.getRoutingTable().markFailed("GN-C", "GN-B");

  const delivered: TransportMessage[] = [];
  engineC.onDelivery(msg => delivered.push(msg));

  const msg = makeMsg("alt-recovery-001", "GN-A", "GN-C");
  const result = await engineA.send(msg);
  assert.equal(result.accepted, true, "Engine must route via the alternative adapter");

  await wait(80);
  assert.equal(delivered.length, 1, "C must receive via the recovered alternate route");

  await engineA.stop();
  await engineC.stop();
});

// ---------------------------------------------------------------------------
// 6. ACK delivery
// ---------------------------------------------------------------------------

test("mesh: ACK delivered from destination to source", async () => {
  const registryA = new TransportRegistry();
  const registryC = new TransportRegistry();

  const simAC = new SimulatorAdapter("sim-ac");
  const simCA = new SimulatorAdapter("sim-ca-ack");
  registryA.register(simAC);
  registryC.register(simCA);
  simAC.connectPeer(simCA);

  const engineA = new MeshEngine(registryA, {
    identity: { nodeId: "GN-A" },
    ackTimeoutMs: 500,
  });
  const engineC = new MeshEngine(registryC, {
    identity: { nodeId: "GN-C" },
    ackTimeoutMs: 500,
  });
  await engineA.start();
  await engineC.start();

  engineA.announceNeighbor("GN-C", "sim-ac");
  engineC.announceNeighbor("GN-A", "sim-ca-ack");

  const acks: AckRecord[] = [];
  engineA.onAck(r => acks.push(r));

  const msg = makeMsg("ack-delivery-001", "GN-A", "GN-C");
  await engineA.send(msg, /* requestAck */ true);

  await wait(200);

  assert.equal(acks.length, 1, "Source must receive one ACK");
  assert.equal(acks[0].originalMessageId, "ack-delivery-001");
  assert.equal(acks[0].ackedBy, "GN-C");

  await engineA.stop();
  await engineC.stop();
});

// ---------------------------------------------------------------------------
// 7. ACK timeout
// ---------------------------------------------------------------------------

test("mesh: ACK timeout fires when no reply arrives", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-no-dest");
  registry.register(sim);
  await sim.start();

  const engine = new MeshEngine(registry, {
    identity: { nodeId: "GN-A" },
    ackTimeoutMs: 80,
  });
  await engine.start();

  // No destination engine exists — ACK will never arrive.
  engine.announceNeighbor("GN-C", "sim-no-dest");

  const timeouts: Array<{ id: string; dest: string }> = [];
  engine.onAckTimeout((id, dest) => timeouts.push({ id, dest }));

  const msg = makeMsg("ack-timeout-001", "GN-A", "GN-C");
  await engine.send(msg, true);

  await wait(200);

  assert.equal(timeouts.length, 1, "onAckTimeout must fire once");
  assert.equal(timeouts[0].id, "ack-timeout-001");
  assert.equal(timeouts[0].dest, "GN-C");

  await engine.stop();
});

// ---------------------------------------------------------------------------
// 8. Retry exhaustion
// ---------------------------------------------------------------------------

test("mesh: retry exhaustion fires route failure after all attempts fail", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-dead");
  registry.register(sim);

  const engine = new MeshEngine(registry, {
    identity: { nodeId: "GN-A" },
    ackTimeoutMs: 60,
    retryIntervalMs: 40,
    maxRetryAttempts: 2,
  });
  await engine.start();
  engine.announceNeighbor("GN-C", "sim-dead");

  const failures: string[] = [];
  engine.onRouteFailure((id) => failures.push(id));

  // Stop the adapter immediately — initial send and all retries will fail.
  await sim.stop();

  const msg = makeMsg("retry-exhaust-001", "GN-A", "GN-C");
  await engine.send(msg, true);

  // Wait: ackTimeout (60ms) + 2 retries × retryInterval (40ms) + buffer (100ms).
  await wait(350);

  assert.ok(failures.length >= 1, "Route failure must be reported after retry exhaustion");

  await engine.stop();
});

// ---------------------------------------------------------------------------
// 9. Duplicate message suppression
// ---------------------------------------------------------------------------

test("mesh: duplicate message suppressed at the mesh layer", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-dup");
  registry.register(sim);

  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });
  await engine.start();

  let deliveryCount = 0;
  engine.onDelivery(() => deliveryCount++);

  const msg = makeMsg("dup-suppress-001", "GN-X", "GN-A");

  // Inject the same message twice via the adapter.
  sim.receiveDirect(msg);
  await wait(10);
  sim.receiveDirect(msg);
  await wait(10);

  assert.equal(deliveryCount, 1, "Second identical message must be suppressed");

  await engine.stop();
});

// ---------------------------------------------------------------------------
// 10. Maximum hop enforcement
// ---------------------------------------------------------------------------

test("mesh: maximum hop count is enforced — packet dropped at TTL", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-hop");
  registry.register(sim);

  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-B" } });
  await engine.start();

  // Install a route so the engine would normally try to forward.
  engine.getRoutingTable().upsert("GN-C", "GN-C", "sim-hop", {
    hopCount: 1,
    signalQuality: 1.0,
    lastConfirmedAt: new Date().toISOString(),
  });

  let deliveryCount = 0;
  engine.onDelivery(() => deliveryCount++);

  // Message at maxHops − 1 — the next forward would hit the limit.
  // forwardDecision checks: nextHopCount = hopCount + 1 >= maxHops.
  const atLimit = makeMsg("hop-limit-001", "GN-A", "GN-C", 3, 4);
  const decision = engine.forwardDecision(atLimit);
  assert.equal(decision.action, "drop", "Engine must drop message at hop limit");
  assert.match((decision as { action: "drop"; reason: string }).reason, /Hop limit/);

  // Also verify via direct injection.
  sim.receiveDirect(atLimit);
  await wait(30);
  assert.equal(deliveryCount, 0, "Dropped message must not be delivered");

  await engine.stop();
});

// ---------------------------------------------------------------------------
// 11. Expired packet rejection
// ---------------------------------------------------------------------------

test("mesh: expired packet is rejected on send", async () => {
  const { engine } = buildEngine("GN-A", "sim-a");
  await engine.start();

  const expiredMsg = makeMsg("expired-001", "GN-A", "GN-C", 0, 8, -1000);
  const result = await engine.send(expiredMsg);
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /expired/i);

  await engine.stop();
});

test("mesh: expired inbound packet is dropped by forward decision", () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-exp");
  registry.register(sim);

  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-B" } });
  const expiredMsg = makeMsg("exp-inbound-001", "GN-A", "GN-C", 0, 8, -1000);
  const decision = engine.forwardDecision(expiredMsg);
  assert.equal(decision.action, "drop");
  assert.match((decision as { action: "drop"; reason: string }).reason, /expired/i);
});

// ---------------------------------------------------------------------------
// 12. Adapter failure isolation
// ---------------------------------------------------------------------------

test("mesh: broadcast failure on one adapter does not block others", async () => {
  const registry = new TransportRegistry();
  const goodSim = new SimulatorAdapter("sim-good-iso");
  const badSim = new SimulatorAdapter("sim-bad-iso");
  registry.register(goodSim);
  registry.register(badSim);

  // Connect a receiver to the good adapter.
  const receiverRegistry = new TransportRegistry();
  const receiverSim = new SimulatorAdapter("sim-recv-iso");
  receiverRegistry.register(receiverSim);
  goodSim.connectPeer(receiverSim);

  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });
  const receiverEngine = new MeshEngine(receiverRegistry, { identity: { nodeId: "GN-RECV" } });
  await engine.start();
  await receiverEngine.start();

  const received: TransportMessage[] = [];
  receiverEngine.onDelivery(m => received.push(m));

  // Stop the bad adapter to force a failure on that adapter.
  await badSim.stop();

  const msg: TransportMessage = {
    ...makeMsg("iso-broadcast-001", "GN-A", "broadcast"),
    destinationNodeId: undefined, // broadcast
  };

  // Broadcast — should succeed via goodSim even though badSim fails.
  const result = await engine.send(msg);
  assert.equal(result.accepted, true, "Broadcast must be accepted by at least one adapter");

  await wait(80);
  assert.equal(received.length, 1, "Receiver on the good adapter must get the message");

  await engine.stop();
  await receiverEngine.stop();
});

test("mesh: single-adapter send failure on a stopped adapter returns rejection", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-stopped");
  registry.register(sim);

  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });
  await engine.start();
  engine.announceNeighbor("GN-B", "sim-stopped");

  // Immediately stop the adapter.
  await sim.stop();

  const msg = makeMsg("send-fail-001", "GN-A", "GN-B");
  const result = await engine.send(msg);
  assert.equal(result.accepted, false, "Send to stopped adapter must fail");
  assert.ok(result.reason, "Failure reason must be provided");
});

// ---------------------------------------------------------------------------
// ForwardDecision unit coverage
// ---------------------------------------------------------------------------

test("mesh: message addressed to this node is delivered, not forwarded", () => {
  const registry = new TransportRegistry();
  registry.register(new SimulatorAdapter("sim-local"));
  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });

  const msg = makeMsg("local-delivery-001", "GN-X", "GN-A");
  const decision = engine.forwardDecision(msg);
  assert.equal(decision.action, "deliver");
});

test("mesh: broadcast message is delivered locally regardless of destination", () => {
  const registry = new TransportRegistry();
  registry.register(new SimulatorAdapter("sim-bcast"));
  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });

  const msg: TransportMessage = {
    ...makeMsg("bcast-decision-001", "GN-X", "broadcast"),
    destinationNodeId: undefined,
  };
  const decision = engine.forwardDecision(msg);
  assert.equal(decision.action, "deliver");
});

test("mesh: message to unknown destination with no route is dropped", () => {
  const registry = new TransportRegistry();
  registry.register(new SimulatorAdapter("sim-noroute"));
  const engine = new MeshEngine(registry, { identity: { nodeId: "GN-A" } });

  const msg = makeMsg("noroute-001", "GN-X", "GN-UNKNOWN");
  const decision = engine.forwardDecision(msg);
  assert.equal(decision.action, "drop");
  assert.match((decision as { action: "drop"; reason: string }).reason, /No route/);
});
