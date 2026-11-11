import test from "node:test";
import assert from "node:assert";
import { decodePacket, encodePacket, encodeTransportPayload, PROTOCOL_MAGIC_BYTE_1, PROTOCOL_MAGIC_BYTE_2, PROTOCOL_VERSION_1 } from "../../src/lib/network/codec";
import { DeduplicationCache, validateTransportMessage, classifyEmergencyText } from "../../src/lib/network/deduplication";
import { TransportRegistry } from "../../src/lib/network/registry";
import { TransportManager } from "../../src/lib/network/manager";
import { SimulatorAdapter } from "../../src/lib/network/adapters/simulator-adapter";
import type { PacketEnvelope, TransportAdapter, TransportMessage, TransportState } from "../../src/lib/network/types";

function createValidMessage(id = "msg-sec-00000001"): TransportMessage {
  return {
    messageId: id,
    sourceNodeId: "GN-SEC-NODE-1",
    destinationNodeId: "broadcast",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hopCount: 0,
    maxHops: 5,
    payload: new Uint8Array([1, 2, 3, 4, 5])
  };
}

// -----------------------------------------------------------------------------
// 1. BUFFER BOUNDARY & TRUNCATION SECURITY
// -----------------------------------------------------------------------------

test("security: reject packet claiming payload length larger than available bytes (buffer over-read attack)", () => {
  // Construct a raw 36-byte buffer where payload length claims 5000 bytes
  const buffer = new Uint8Array(40);
  const view = new DataView(buffer.buffer);
  buffer[0] = PROTOCOL_MAGIC_BYTE_1;
  buffer[1] = PROTOCOL_MAGIC_BYTE_2;
  buffer[2] = PROTOCOL_VERSION_1;
  buffer[3] = 0; // flags
  buffer[4] = 0; // hopCount
  buffer[5] = 5; // maxHops
  view.setBigUint64(6, BigInt(Date.now()), false);
  view.setBigUint64(14, BigInt(Date.now() + 60_000), false);
  view.setUint16(22, 4, false); // src len = 4
  buffer.set([65, 66, 67, 68], 24); // "ABCD"
  view.setUint16(28, 0, false); // dst len = 0
  view.setUint16(30, 4, false); // msgId len = 4
  buffer.set([49, 50, 51, 52], 32); // "1234"
  // At offset 36, declare payload length of 10000 bytes, but only 0 bytes remain
  const totalBuf = new Uint8Array(40);
  totalBuf.set(buffer);
  const totalView = new DataView(totalBuf.buffer);
  totalView.setUint32(36, 10000, false);

  assert.throws(() => decodePacket(totalBuf), /Truncated packet: expected 10000 payload bytes/);
});

test("security: reject declared payload length exceeding maximum allowed MTU limit", () => {
  const buffer = new Uint8Array(50);
  const view = new DataView(buffer.buffer);
  buffer[0] = PROTOCOL_MAGIC_BYTE_1;
  buffer[1] = PROTOCOL_MAGIC_BYTE_2;
  buffer[2] = PROTOCOL_VERSION_1;
  view.setBigUint64(6, BigInt(Date.now()), false);
  view.setBigUint64(14, BigInt(Date.now() + 60_000), false);
  view.setUint16(22, 2, false); // src len
  buffer.set([65, 66], 24);
  view.setUint16(26, 0, false); // dst len
  view.setUint16(28, 2, false); // id len
  buffer.set([49, 50], 30);
  view.setUint32(32, 200_000, false); // declare 200 KB payload

  assert.throws(() => decodePacket(buffer, 64 * 1024), /Declared payload length .* exceeds maximum limit/);
});

test("security: reject packet with truncated source or destination string fields", () => {
  const truncatedBuffer = new Uint8Array(34);
  truncatedBuffer[0] = PROTOCOL_MAGIC_BYTE_1;
  truncatedBuffer[1] = PROTOCOL_MAGIC_BYTE_2;
  truncatedBuffer[2] = PROTOCOL_VERSION_1;
  const view = new DataView(truncatedBuffer.buffer);
  view.setBigUint64(6, BigInt(Date.now()), false);
  view.setBigUint64(14, BigInt(Date.now() + 60_000), false);
  view.setUint16(22, 50, false); // claims src is 50 bytes, but buffer only has 10 bytes remaining

  assert.throws(() => decodePacket(truncatedBuffer), /Truncated packet reading source node ID/);
});

// -----------------------------------------------------------------------------
// 2. REPLAY ATTACKS & EXPIRATION PROTECTION
// -----------------------------------------------------------------------------

test("security: prevent replay attack of identical message ID", () => {
  const cache = new DeduplicationCache(1000);
  const attackMessageId = "msg-attack-replay-001";

  // First ingestion succeeds
  const firstSeen = cache.add(attackMessageId);
  assert.strictEqual(firstSeen, true, "First message ingestion must be accepted");

  // Replay attempt must be detected and rejected
  const replayAttempt = cache.add(attackMessageId);
  assert.strictEqual(replayAttempt, false, "Replayed message ID must be rejected");
});

test("security: reject replay of expired message", () => {
  const expiredMessage: TransportMessage = {
    messageId: "msg-expired-replay",
    sourceNodeId: "GN-ATTACKER",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 10_000).toISOString(), // expired 10s ago
    hopCount: 0,
    maxHops: 3,
    payload: new Uint8Array([1, 2, 3])
  };

  const validation = validateTransportMessage(expiredMessage);
  assert.strictEqual(validation.valid, false);
  assert.match(validation.error ?? "", /Message has already expired/);
});

// -----------------------------------------------------------------------------
// 3. HOP LIMIT & ROUTING AMPLIFICATION PROTECTION
// -----------------------------------------------------------------------------

test("security: reject negative hop count spoofing", () => {
  const msg = createValidMessage();
  msg.hopCount = -1;

  const validation = validateTransportMessage(msg);
  assert.strictEqual(validation.valid, false);
  assert.match(validation.error ?? "", /Hop count cannot be negative/);
});

test("security: reject excessive maxHops to prevent network amplification attacks", () => {
  const msg = createValidMessage();
  msg.maxHops = 100; // unbounded/extreme hop limit

  const validation = validateTransportMessage(msg);
  assert.strictEqual(validation.valid, false);
  assert.match(validation.error ?? "", /Max hops must be between 1 and 32/);
});

test("security: reject packet that has reached its maximum hop count", () => {
  const msg = createValidMessage();
  msg.hopCount = 5;
  msg.maxHops = 5;

  const validation = validateTransportMessage(msg);
  assert.strictEqual(validation.valid, false);
  assert.match(validation.error ?? "", /Hop limit reached/);
});

// -----------------------------------------------------------------------------
// 4. RESOURCE EXHAUSTION & DENIAL OF SERVICE (DoS) DEFENSE
// -----------------------------------------------------------------------------

test("security: bounded deduplication cache resists memory exhaustion under flooding", () => {
  const maxEntries = 50;
  const cache = new DeduplicationCache(maxEntries);

  // Flood cache with 500 distinct IDs
  for (let i = 0; i < 500; i++) {
    cache.add(`flood-msg-id-${i}`);
  }

  // Cache must never grow beyond maxEntries
  assert.strictEqual(cache.size(), maxEntries, "Cache size must be strictly bounded");
  // Oldest items must have been safely evicted
  assert.strictEqual(cache.has("flood-msg-id-0"), false, "Oldest item should be evicted");
  // Newest item must be retained
  assert.strictEqual(cache.has("flood-msg-id-499"), true, "Newest item should be present");
});

test("security: reject zero-byte empty payload", () => {
  const msg = createValidMessage();
  msg.payload = new Uint8Array(0);

  const validation = validateTransportMessage(msg);
  assert.strictEqual(validation.valid, false);
  assert.match(validation.error ?? "", /Payload cannot be empty/);
});

test("security: reject payload exceeding MTU limit", () => {
  const msg = createValidMessage();
  msg.payload = new Uint8Array(70 * 1024); // 70 KB > 64 KB default limit

  const validation = validateTransportMessage(msg);
  assert.strictEqual(validation.valid, false);
  assert.match(validation.error ?? "", /exceeds max limit/);
});

// -----------------------------------------------------------------------------
// 5. CRASH & FAULT ISOLATION (HOSTILE / FAILING ADAPTERS)
// -----------------------------------------------------------------------------

test("security: malicious adapter throwing synchronous error does not crash manager or other adapters", async () => {
  const registry = new TransportRegistry();
  const healthySim = new SimulatorAdapter("sim-healthy");
  registry.register(healthySim);

  // Hostile adapter that throws immediately on send
  const crashingAdapter: TransportAdapter = {
    id: "hostile-radio",
    kind: "lora",
    capabilities: {
      maxPayloadBytes: 256,
      estimatedBandwidthBps: 1000,
      supportsBroadcast: true,
      supportsUnicast: true,
      supportsAcknowledgements: false,
      longRange: true
    },
    async initialize() {},
    async start() {},
    async stop() {},
    send() {
      throw new Error("CRITICAL_HARDWARE_FAULT: Bus lockup");
    },
    onReceive() {
      return () => {};
    },
    async getStatus() {
      return "ready" as TransportState;
    }
  };
  registry.register(crashingAdapter);

  const manager = new TransportManager(registry);
  await manager.startAll();

  // Send specifically to crashing adapter
  const singleResult = await manager.send("hostile-radio", createValidMessage());
  assert.strictEqual(singleResult.accepted, false);
  assert.match(singleResult.reason ?? "", /CRITICAL_HARDWARE_FAULT/);

  // Broadcast across both adapters
  const broadcastResults = await manager.broadcast(createValidMessage());
  assert.strictEqual(broadcastResults.length, 2);

  const healthyResult = broadcastResults.find(r => r.adapterId === "sim-healthy");
  const hostileResult = broadcastResults.find(r => r.adapterId === "hostile-radio");

  assert.ok(healthyResult);
  assert.strictEqual(healthyResult.accepted, true, "Healthy adapter must succeed despite peer crash");
  assert.ok(hostileResult);
  assert.strictEqual(hostileResult.accepted, false);
});

test("security: exception inside inbound message handler does not crash dispatch pipeline", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-dispatch-sec");
  registry.register(sim);

  const manager = new TransportManager(registry);
  await manager.startAll();

  let survivingHandlerCalled = false;

  // Handler 1 throws malicious exception
  manager.onMessage(() => {
    throw new Error("MALICIOUS_INBOUND_HANDLER_EXCEPTION");
  });

  // Handler 2 should still execute safely
  manager.onMessage(() => {
    survivingHandlerCalled = true;
  });

  // Trigger inbound message
  sim.receiveDirect(createValidMessage("msg-sec-inbound"));

  assert.strictEqual(survivingHandlerCalled, true, "Surviving handler must receive message even if prior handler threw");
});

// -----------------------------------------------------------------------------
// 6. INJECTION & ADVERSARIAL PAYLOAD SAFETY
// -----------------------------------------------------------------------------

test("security: message payload containing SQL injection and XSS characters encodes and decodes safely", () => {
  const maliciousPayload = {
    body: "'); DROP TABLE messages; -- <script>alert('xss')</script>\0\u0000\uFFFD",
    sender: "GN-001<img src=x onerror=alert(1)>"
  };

  const encodedBytes = encodeTransportPayload(maliciousPayload);
  const envelope: PacketEnvelope = {
    version: PROTOCOL_VERSION_1,
    flags: 0,
    messageId: "msg-injection-test-01",
    sourceNodeId: "GN-SEC-01",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    hopCount: 0,
    maxHops: 3,
    payload: encodedBytes
  };

  const packet = encodePacket(envelope);
  const decoded = decodePacket(packet);

  assert.strictEqual(decoded.messageId, "msg-injection-test-01");
  const restored = JSON.parse(new TextDecoder().decode(decoded.payload));
  assert.strictEqual(restored.body, maliciousPayload.body);
  assert.strictEqual(restored.sender, maliciousPayload.sender);
});

// -----------------------------------------------------------------------------
// 7. ADVISORY EMERGENCY CLASSIFICATION INTEGRITY
// -----------------------------------------------------------------------------

test("security: critical emergencies must enforce human review requirement", () => {
  const medicalSos = classifyEmergencyText("URGENT: Cardiac arrest, need CPR and ambulance immediately!");
  assert.strictEqual(medicalSos.classification, "medical");
  assert.strictEqual(medicalSos.humanReviewRequired, true, "Medical emergency must require human review");

  const fire = classifyEmergencyText("Explosion and rapid spreading fire at warehouse!");
  assert.strictEqual(fire.classification, "fire");
  assert.strictEqual(fire.humanReviewRequired, true, "Fire emergency must require human review");

  const rescue = classifyEmergencyText("Three people trapped after earthquake collapse");
  assert.strictEqual(rescue.classification, "rescue");
  assert.strictEqual(rescue.humanReviewRequired, true, "Rescue emergency must require human review");

  // Benign message should not flag human review
  const benign = classifyEmergencyText("Status update: shift ended normally.");
  assert.strictEqual(benign.classification, "unclassified");
  assert.strictEqual(benign.humanReviewRequired, false);
});
