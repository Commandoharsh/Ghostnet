/**
 * Phase 4 — Neighbor Table
 *
 * Tracks directly-reachable peers, their transport links, signal quality,
 * and last-seen timestamps.  Entries expire automatically after a configurable
 * TTL.  Pure TypeScript; no browser or framework dependencies.
 */

import type { NeighborEntry } from "./mesh-types";
import type { TransportKind } from "./types";

export class NeighborTable {
  private readonly entries = new Map<string, NeighborEntry>();
  private readonly ttlMs: number;

  /**
   * @param ttlMs  How long a neighbor entry is considered valid after the
   *               last time it was seen.  Default 60 000 ms (1 minute).
   */
  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Add or refresh a neighbor.  If an entry for nodeId already exists it is
   * updated in place (last-seen, signal quality, adapter, transport kind).
   */
  update(
    nodeId: string,
    adapterId: string,
    transportKind: TransportKind,
    signalQuality?: number,
  ): void {
    if (!nodeId || !adapterId) return;
    this.entries.set(nodeId, {
      nodeId,
      adapterId,
      transportKind,
      lastSeenAt: new Date().toISOString(),
      signalQuality,
    });
  }

  /**
   * Returns the entry for nodeId if it exists and has not expired.
   * Removes and returns undefined if the entry has expired.
   */
  get(nodeId: string): NeighborEntry | undefined {
    const entry = this.entries.get(nodeId);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(nodeId);
      return undefined;
    }
    return { ...entry };
  }

  /** Returns true if the neighbor is known and not expired. */
  has(nodeId: string): boolean {
    return this.get(nodeId) !== undefined;
  }

  /** Remove a specific neighbor manually (e.g. after confirmed failure). */
  remove(nodeId: string): boolean {
    return this.entries.delete(nodeId);
  }

  /**
   * Returns all non-expired neighbor entries, pruning any that have expired.
   */
  list(): NeighborEntry[] {
    this.prune();
    return Array.from(this.entries.values()).map(e => ({ ...e }));
  }

  /**
   * Removes all entries whose last-seen timestamp is older than ttlMs.
   * Returns the number of entries removed.
   */
  prune(): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Total number of entries (including potentially expired ones). */
  size(): number {
    return this.entries.size;
  }

  private isExpired(entry: NeighborEntry): boolean {
    const lastSeen = Date.parse(entry.lastSeenAt);
    return Date.now() - lastSeen > this.ttlMs;
  }
}
