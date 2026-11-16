/**
 * Phase 4 — ACK Tracker
 *
 * Tracks delivery acknowledgements for outbound messages.
 *
 * - Correlates received ACKs with pending entries by original message ID.
 * - Suppresses duplicate ACKs for the same message.
 * - Fires timeout callbacks when an ACK is not received within the deadline.
 * - Pure TypeScript; no browser or framework dependencies.
 *   Uses setTimeout/clearTimeout which are available in Node.js and browsers.
 */

import type { AckRecord, PendingAck } from "./mesh-types";

export class AckTracker {
  private readonly pending = new Map<string, PendingAck & { timerId: ReturnType<typeof setTimeout> }>();
  private readonly received = new Set<string>();

  /**
   * Register a message as awaiting acknowledgement.
   *
   * @param entry  PendingAck descriptor including timeout and callbacks.
   * @returns true if registered; false if an ACK was already received for
   *          this message ID (duplicate suppression on the sender side).
   */
  expect(entry: PendingAck): boolean {
    if (this.received.has(entry.messageId)) {
      // ACK already arrived before expect() was called (race on fast links).
      entry.onAck({
        originalMessageId: entry.messageId,
        ackedBy: "already-received",
        ackedAt: new Date().toISOString(),
      });
      return false;
    }

    if (this.pending.has(entry.messageId)) {
      // Already registered — ignore duplicate expect() calls.
      return false;
    }

    const timerId = setTimeout(() => {
      this.pending.delete(entry.messageId);
      entry.onTimeout();
    }, entry.timeoutMs);

    this.pending.set(entry.messageId, { ...entry, timerId });
    return true;
  }

  /**
   * Deliver an ACK for originalMessageId.
   *
   * @param record  The AckRecord received from the network.
   * @returns true if the ACK resolved a pending entry; false if it was a
   *          duplicate or unexpected ACK (no pending entry found).
   */
  receive(record: AckRecord): boolean {
    if (this.received.has(record.originalMessageId)) {
      // Duplicate ACK — suppress silently.
      return false;
    }
    this.received.add(record.originalMessageId);

    const entry = this.pending.get(record.originalMessageId);
    if (!entry) {
      // ACK arrived but nothing was waiting (message already timed out or
      // was never registered — harmless).
      return false;
    }

    clearTimeout(entry.timerId);
    this.pending.delete(record.originalMessageId);
    entry.onAck(record);
    return true;
  }

  /**
   * Cancel and remove a pending ACK entry without firing callbacks.
   * Used when the retry manager gives up on a message entirely.
   */
  cancel(messageId: string): void {
    const entry = this.pending.get(messageId);
    if (entry) {
      clearTimeout(entry.timerId);
      this.pending.delete(messageId);
    }
  }

  /** Whether an ACK entry is currently outstanding for messageId. */
  hasPending(messageId: string): boolean {
    return this.pending.has(messageId);
  }

  /** Whether an ACK has been received (and recorded) for messageId. */
  hasReceived(messageId: string): boolean {
    return this.received.has(messageId);
  }

  /** Number of messages currently awaiting an ACK. */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancel all pending entries and clear state.
   * Call on engine shutdown to prevent timer leaks.
   */
  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timerId);
    }
    this.pending.clear();
    this.received.clear();
  }
}
