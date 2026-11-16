/**
 * Phase 4 — In-memory MessageStore implementation.
 *
 * Implements the MessageStore interface for use in tests and the Phase 4
 * mesh engine.  Phase 12 will replace this with a SQLite-backed store.
 *
 * Pure TypeScript; no browser or framework dependencies.
 */

import type { MessageStore } from "./mesh-types";

interface StoreEntry {
  payload: Uint8Array;
  receivedAt: string;
}

export class InMemoryMessageStore implements MessageStore {
  private readonly store = new Map<string, StoreEntry>();

  async put(messageId: string, payload: Uint8Array, receivedAt: string): Promise<void> {
    if (this.store.has(messageId)) return; // idempotent
    this.store.set(messageId, {
      payload: new Uint8Array(payload),
      receivedAt,
    });
  }

  async has(messageId: string): Promise<boolean> {
    return this.store.has(messageId);
  }

  async get(messageId: string): Promise<Uint8Array | undefined> {
    const entry = this.store.get(messageId);
    if (!entry) return undefined;
    return new Uint8Array(entry.payload);
  }

  async purgeExpiredBefore(isoTimestamp: string): Promise<number> {
    const cutoffMs = Date.parse(isoTimestamp);
    if (!Number.isFinite(cutoffMs)) return 0;
    let count = 0;
    for (const [id, entry] of this.store) {
      if (Date.parse(entry.receivedAt) < cutoffMs) {
        this.store.delete(id);
        count++;
      }
    }
    return count;
  }

  size(): number {
    return this.store.size;
  }
}
