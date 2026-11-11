import test from "node:test";
import assert from "node:assert";
import {
  decodePacket,
  decodeTransportPayload,
  encodePacket,
  encodeTransportPayload,
  envelopeToTransportMessage,
  PROTOCOL_MAGIC_BYTE_1,
  PROTOCOL_MAGIC_BYTE_2,
  PROTOCOL_VERSION_1,
  transportMessageToEnvelope
} from "../../src/lib/network/codec";
import type { PacketEnvelope, TransportMessage } from "../../src/lib/network/types";

test("codec: encode and decode valid packet envelope", () => {
  const payload = encodeTransportPayload({ text: "Emergency SOS", priority: "critical" });
  const envelope: PacketEnvelope = {
    version: PROTOCOL_VERSION_1,
    flags: 1, // broadcast
    messageId: "msg-12345678-test",
    sourceNodeId: "GN-NODE-ALPHA",
    destinationNodeId: "GN-NODE-BRAVO",
    createdAtMs: 1700000000000,
    expiresAtMs: 1700086400000,
    hopCount: 1,
    maxHops: 5,
    payload
  };

  const encoded = encodePacket(envelope);
  assert.ok(encoded.byteLength > 32);
  assert.strictEqual(encoded[0], PROTOCOL_MAGIC_BYTE_1);
  assert.strictEqual(encoded[1], PROTOCOL_MAGIC_BYTE_2);
  assert.strictEqual(encoded[2], PROTOCOL_VERSION_1);

  const decoded = decodePacket(encoded);
  assert.strictEqual(decoded.version, envelope.version);
  assert.strictEqual(decoded.flags, envelope.flags);
  assert.strictEqual(decoded.messageId, envelope.messageId);
  assert.strictEqual(decoded.sourceNodeId, envelope.sourceNodeId);
  assert.strictEqual(decoded.destinationNodeId, envelope.destinationNodeId);
  assert.strictEqual(decoded.createdAtMs, envelope.createdAtMs);
  assert.strictEqual(decoded.expiresAtMs, envelope.expiresAtMs);
  assert.strictEqual(decoded.hopCount, envelope.hopCount);
  assert.strictEqual(decoded.maxHops, envelope.maxHops);

  const decodedPayload = decodeTransportPayload<{ text: string; priority: string }>(decoded.payload);
  assert.strictEqual(decodedPayload.text, "Emergency SOS");
  assert.strictEqual(decodedPayload.priority, "critical");
});

test("codec: reject packet smaller than 32 bytes", () => {
  const tinyBuffer = new Uint8Array([0x47, 0x4e, 0x01]);
  assert.throws(() => decodePacket(tinyBuffer), /Packet too small/);
});

test("codec: reject corrupt magic bytes", () => {
  const badMagic = new Uint8Array(32);
  badMagic[0] = 0xff;
  badMagic[1] = 0xfe;
  assert.throws(() => decodePacket(badMagic), /Invalid protocol magic header/);
});

test("codec: reject payload exceeding MTU limit", () => {
  const largePayload = new Uint8Array(500);
  const envelope: PacketEnvelope = {
    version: PROTOCOL_VERSION_1,
    flags: 0,
    messageId: "msg-12345678-test",
    sourceNodeId: "GN-SRC",
    createdAtMs: 1700000000000,
    expiresAtMs: 1700086400000,
    hopCount: 0,
    maxHops: 3,
    payload: largePayload
  };

  assert.throws(() => encodePacket(envelope, 256), /exceeds MTU limit/);
});

test("codec: reject hop count exceeding or equal to maxHops", () => {
  const envelope: PacketEnvelope = {
    version: PROTOCOL_VERSION_1,
    flags: 0,
    messageId: "msg-12345678-test",
    sourceNodeId: "GN-SRC",
    createdAtMs: 1700000000000,
    expiresAtMs: 1700086400000,
    hopCount: 3,
    maxHops: 3,
    payload: new Uint8Array([1, 2, 3])
  };

  assert.throws(() => encodePacket(envelope), /Invalid hop count/);
});

test("codec: reject expiry timestamp prior to creation", () => {
  const envelope: PacketEnvelope = {
    version: PROTOCOL_VERSION_1,
    flags: 0,
    messageId: "msg-12345678-test",
    sourceNodeId: "GN-SRC",
    createdAtMs: 1700086400000,
    expiresAtMs: 1700000000000,
    hopCount: 0,
    maxHops: 3,
    payload: new Uint8Array([1, 2, 3])
  };

  assert.throws(() => encodePacket(envelope), /must be after creation/);
});

test("codec: envelope to transport message conversions", () => {
  const msg: TransportMessage = {
    messageId: "msg-convert-9999",
    sourceNodeId: "GN-001",
    destinationNodeId: "GN-002",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    expiresAt: new Date("2026-01-02T00:00:00Z").toISOString(),
    hopCount: 0,
    maxHops: 4,
    payload: encodeTransportPayload("Hello Mesh")
  };

  const env = transportMessageToEnvelope(msg);
  const roundtrip = envelopeToTransportMessage(env);

  assert.strictEqual(roundtrip.messageId, msg.messageId);
  assert.strictEqual(roundtrip.sourceNodeId, msg.sourceNodeId);
  assert.strictEqual(roundtrip.destinationNodeId, msg.destinationNodeId);
  assert.strictEqual(roundtrip.hopCount, msg.hopCount);
  assert.strictEqual(roundtrip.maxHops, msg.maxHops);
  assert.strictEqual(decodeTransportPayload(roundtrip.payload), "Hello Mesh");
});
