import type { TransportMessage } from "./types";

export interface CacheEntry {
  messageId: string;
  expiresAtMs: number;
  addedAtMs: number;
}

export class DeduplicationCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(maxEntries = 10_000, defaultTtlMs = 24 * 60 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Check if a message has already been processed or seen.
   */
  has(messageId: string): boolean {
    const entry = this.entries.get(messageId);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAtMs) {
      this.entries.delete(messageId);
      return false;
    }
    return true;
  }

  /**
   * Add a message ID to the deduplication cache.
   * Returns true if newly added, or false if it was already known.
   */
  add(messageId: string, expiresAtMs?: number): boolean {
    if (this.has(messageId)) {
      return false;
    }

    // Enforce bounded cache size: evict oldest entry if at capacity
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }

    const now = Date.now();
    this.entries.set(messageId, {
      messageId,
      addedAtMs: now,
      expiresAtMs: expiresAtMs ?? now + this.defaultTtlMs
    });
    return true;
  }

  /**
   * Prune expired message IDs from memory.
   */
  prune(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (now >= entry.expiresAtMs) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function validateTransportMessage(
  message: TransportMessage,
  maxPayloadBytes = 64 * 1024
): { valid: boolean; error?: string } {
  if (!message.messageId || typeof message.messageId !== "string" || message.messageId.trim().length < 8) {
    return { valid: false, error: "Message ID must be a non-empty string of at least 8 characters" };
  }
  if (!message.sourceNodeId || typeof message.sourceNodeId !== "string" || !message.sourceNodeId.trim()) {
    return { valid: false, error: "Source Node ID is required" };
  }
  if (!(message.payload instanceof Uint8Array)) {
    return { valid: false, error: "Payload must be a Uint8Array" };
  }
  if (message.payload.byteLength === 0) {
    return { valid: false, error: "Payload cannot be empty" };
  }
  if (message.payload.byteLength > maxPayloadBytes) {
    return { valid: false, error: `Payload byte length (${message.payload.byteLength}) exceeds max limit (${maxPayloadBytes})` };
  }
  if (message.hopCount < 0) {
    return { valid: false, error: "Hop count cannot be negative" };
  }
  if (message.maxHops < 1 || message.maxHops > 32) {
    return { valid: false, error: "Max hops must be between 1 and 32" };
  }
  if (message.hopCount >= message.maxHops) {
    return { valid: false, error: `Hop limit reached (${message.hopCount}/${message.maxHops})` };
  }

  const created = Date.parse(message.createdAt);
  const expiry = Date.parse(message.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expiry)) {
    return { valid: false, error: "Invalid timestamp format (expected ISO 8601 UTC)" };
  }
  if (expiry <= created) {
    return { valid: false, error: "Expiry timestamp must be strictly after creation timestamp" };
  }
  if (expiry <= Date.now()) {
    return { valid: false, error: "Message has already expired" };
  }

  return { valid: true };
}

export function classifyEmergencyText(text: string): {
  classification: "medical" | "fire" | "rescue" | "unclassified";
  humanReviewRequired: boolean;
} {
  const value = text.toLowerCase();
  if (/heart attack|not breathing|bleeding|medical|injured|ambulance|sos/.test(value)) {
    return { classification: "medical", humanReviewRequired: true };
  }
  if (/fire|smoke|burning/.test(value)) {
    return { classification: "fire", humanReviewRequired: true };
  }
  if (/collapse|trapped|rescue|earthquake/.test(value)) {
    return { classification: "rescue", humanReviewRequired: true };
  }
  return { classification: "unclassified", humanReviewRequired: false };
}
