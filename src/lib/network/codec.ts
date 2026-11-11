import type { PacketEnvelope, TransportMessage } from "./types";

export const PROTOCOL_MAGIC_BYTE_1 = 0x47; // 'G'
export const PROTOCOL_MAGIC_BYTE_2 = 0x4e; // 'N'
export const PROTOCOL_VERSION_1 = 0x01;
export const DEFAULT_MAX_PACKET_BYTES = 64 * 1024; // 64 KB

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeTransportPayload(data: unknown): Uint8Array {
  if (typeof data === "string") {
    return textEncoder.encode(data);
  }
  return textEncoder.encode(JSON.stringify(data));
}

export function decodeTransportPayload<T = unknown>(bytes: Uint8Array): T {
  const text = textDecoder.decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export function encodePacket(envelope: PacketEnvelope, maxPayloadBytes = DEFAULT_MAX_PACKET_BYTES): Uint8Array {
  if (envelope.payload.byteLength > maxPayloadBytes) {
    throw new Error(`Payload byte length (${envelope.payload.byteLength}) exceeds MTU limit (${maxPayloadBytes})`);
  }
  if (envelope.hopCount < 0 || envelope.maxHops < 1 || envelope.hopCount >= envelope.maxHops) {
    throw new Error(`Invalid hop count (${envelope.hopCount}) for max hops (${envelope.maxHops})`);
  }
  if (envelope.expiresAtMs <= envelope.createdAtMs) {
    throw new Error(`Message expiry (${envelope.expiresAtMs}) must be after creation (${envelope.createdAtMs})`);
  }

  const srcBytes = textEncoder.encode(envelope.sourceNodeId);
  const dstBytes = envelope.destinationNodeId ? textEncoder.encode(envelope.destinationNodeId) : new Uint8Array(0);
  const idBytes = textEncoder.encode(envelope.messageId);

  const totalLength = 32 + srcBytes.length + dstBytes.length + idBytes.length + envelope.payload.byteLength;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let offset = 0;
  // Magic bytes
  buffer[offset++] = PROTOCOL_MAGIC_BYTE_1;
  buffer[offset++] = PROTOCOL_MAGIC_BYTE_2;
  // Version
  buffer[offset++] = envelope.version || PROTOCOL_VERSION_1;
  // Flags
  buffer[offset++] = envelope.flags & 0xff;
  // Hop count & Max hops
  buffer[offset++] = envelope.hopCount & 0xff;
  buffer[offset++] = envelope.maxHops & 0xff;
  // Created & Expires timestamps (64-bit ms)
  view.setBigUint64(offset, BigInt(envelope.createdAtMs), false);
  offset += 8;
  view.setBigUint64(offset, BigInt(envelope.expiresAtMs), false);
  offset += 8;
  // Source Node ID
  view.setUint16(offset, srcBytes.length, false);
  offset += 2;
  buffer.set(srcBytes, offset);
  offset += srcBytes.length;
  // Destination Node ID
  view.setUint16(offset, dstBytes.length, false);
  offset += 2;
  if (dstBytes.length > 0) {
    buffer.set(dstBytes, offset);
    offset += dstBytes.length;
  }
  // Message ID
  view.setUint16(offset, idBytes.length, false);
  offset += 2;
  buffer.set(idBytes, offset);
  offset += idBytes.length;
  // Payload length & data
  view.setUint32(offset, envelope.payload.byteLength, false);
  offset += 4;
  buffer.set(envelope.payload, offset);

  return buffer;
}

export function decodePacket(buffer: Uint8Array, maxAllowedBytes = DEFAULT_MAX_PACKET_BYTES): PacketEnvelope {
  if (buffer.byteLength < 32) {
    throw new Error(`Packet too small (${buffer.byteLength} bytes); minimum header is 32 bytes`);
  }
  if (buffer.byteLength > maxAllowedBytes + 512) {
    throw new Error(`Packet size (${buffer.byteLength}) exceeds maximum allowed bytes (${maxAllowedBytes + 512})`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;

  const magic1 = buffer[offset++];
  const magic2 = buffer[offset++];
  if (magic1 !== PROTOCOL_MAGIC_BYTE_1 || magic2 !== PROTOCOL_MAGIC_BYTE_2) {
    throw new Error(`Invalid protocol magic header: 0x${magic1.toString(16)}, 0x${magic2.toString(16)}`);
  }

  const version = buffer[offset++];
  if (version !== PROTOCOL_VERSION_1) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const flags = buffer[offset++];
  const hopCount = buffer[offset++];
  const maxHops = buffer[offset++];

  const createdAtMs = Number(view.getBigUint64(offset, false));
  offset += 8;
  const expiresAtMs = Number(view.getBigUint64(offset, false));
  offset += 8;

  if (buffer.byteLength < offset + 2) throw new Error("Truncated packet reading source node length");
  const srcLen = view.getUint16(offset, false);
  offset += 2;
  if (buffer.byteLength < offset + srcLen) throw new Error("Truncated packet reading source node ID");
  const sourceNodeId = textDecoder.decode(buffer.subarray(offset, offset + srcLen));
  offset += srcLen;

  if (buffer.byteLength < offset + 2) throw new Error("Truncated packet reading destination node length");
  const dstLen = view.getUint16(offset, false);
  offset += 2;
  let destinationNodeId: string | undefined;
  if (dstLen > 0) {
    if (buffer.byteLength < offset + dstLen) throw new Error("Truncated packet reading destination node ID");
    destinationNodeId = textDecoder.decode(buffer.subarray(offset, offset + dstLen));
    offset += dstLen;
  }

  if (buffer.byteLength < offset + 2) throw new Error("Truncated packet reading message ID length");
  const idLen = view.getUint16(offset, false);
  offset += 2;
  if (buffer.byteLength < offset + idLen) throw new Error("Truncated packet reading message ID");
  const messageId = textDecoder.decode(buffer.subarray(offset, offset + idLen));
  offset += idLen;

  if (buffer.byteLength < offset + 4) throw new Error("Truncated packet reading payload length");
  const payloadLen = view.getUint32(offset, false);
  offset += 4;

  if (payloadLen > maxAllowedBytes) {
    throw new Error(`Declared payload length (${payloadLen}) exceeds maximum limit (${maxAllowedBytes})`);
  }
  if (buffer.byteLength < offset + payloadLen) {
    throw new Error(`Truncated packet: expected ${payloadLen} payload bytes, but only ${buffer.byteLength - offset} available`);
  }

  const payload = buffer.slice(offset, offset + payloadLen);

  return {
    version,
    flags,
    messageId,
    sourceNodeId,
    destinationNodeId,
    createdAtMs,
    expiresAtMs,
    hopCount,
    maxHops,
    payload
  };
}

export function transportMessageToEnvelope(message: TransportMessage, flags = 0): PacketEnvelope {
  return {
    version: PROTOCOL_VERSION_1,
    flags,
    messageId: message.messageId,
    sourceNodeId: message.sourceNodeId,
    destinationNodeId: message.destinationNodeId,
    createdAtMs: Date.parse(message.createdAt),
    expiresAtMs: Date.parse(message.expiresAt),
    hopCount: message.hopCount,
    maxHops: message.maxHops,
    payload: message.payload
  };
}

export function envelopeToTransportMessage(envelope: PacketEnvelope): TransportMessage {
  return {
    messageId: envelope.messageId,
    sourceNodeId: envelope.sourceNodeId,
    destinationNodeId: envelope.destinationNodeId,
    createdAt: new Date(envelope.createdAtMs).toISOString(),
    expiresAt: new Date(envelope.expiresAtMs).toISOString(),
    hopCount: envelope.hopCount,
    maxHops: envelope.maxHops,
    payload: envelope.payload
  };
}
