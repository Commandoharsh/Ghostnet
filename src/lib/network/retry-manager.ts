/**
 * Phase 4 — Retry Manager
 *
 * Manages a bounded retry queue for messages that failed to reach their
 * destination.  On each retry it looks up an alternative route in the routing
 * table and attempts re-transmission through the mesh engine.
 *
 * Design constraints:
 *   - Bounded queue (maxQueueSize entries) to prevent unbounded memory growth.
 *   - Configurable per-message retry limit and interval.
 *   - Each retry attempt uses an alternative route when the primary failed.
 *   - Exhausted retries surface a "route failure" notification to the caller.
 *   - Pure TypeScript; no browser or framework dependencies.
 */

import type { RetryRecord } from "./mesh-types";
import type { TransportMessage } from "./types";

export type RetryAttemptFn = (
  record: RetryRecord,
) => Promise<{ accepted: boolean; reason?: string }>;

export type RetryExhaustedFn = (record: RetryRecord) => void;

export interface RetryManagerConfig {
  /** Maximum retry attempts per message. Default 3. */
  maxAttempts?: number;
  /** Delay between attempts in ms. Default 2 000. */
  retryIntervalMs?: number;
  /** Maximum number of records in the retry queue. Default 200. */
  maxQueueSize?: number;
}

export class RetryManager {
  private readonly queue = new Map<string, RetryRecord>();
  private readonly maxAttempts: number;
  private readonly retryIntervalMs: number;
  private readonly maxQueueSize: number;
  private timerId: ReturnType<typeof setInterval> | null = null;

  constructor(config: RetryManagerConfig = {}) {
    this.maxAttempts = config.maxAttempts ?? 3;
    this.retryIntervalMs = config.retryIntervalMs ?? 2_000;
    this.maxQueueSize = config.maxQueueSize ?? 200;
  }

  /**
   * Enqueue a message for retry.
   *
   * @returns true if enqueued; false if the queue is full or the message
   *          is already tracked.
   */
  enqueue(
    message: TransportMessage,
    adapterId: string,
    maxAttempts = this.maxAttempts,
    retryIntervalMs = this.retryIntervalMs,
  ): boolean {
    if (this.queue.has(message.messageId)) return false;
    if (this.queue.size >= this.maxQueueSize) return false;

    const record: RetryRecord = {
      messageId: message.messageId,
      message: { ...message, payload: new Uint8Array(message.payload) },
      adapterId,
      destinationId: message.destinationNodeId ?? "broadcast",
      attemptCount: 0,
      maxAttempts,
      retryIntervalMs,
      nextRetryAtMs: Date.now() + retryIntervalMs,
    };

    this.queue.set(message.messageId, record);
    return true;
  }

  /** Remove a message from the retry queue (e.g. after successful delivery). */
  remove(messageId: string): boolean {
    return this.queue.delete(messageId);
  }

  /** Whether a message is currently queued for retry. */
  has(messageId: string): boolean {
    return this.queue.has(messageId);
  }

  /** Number of messages currently queued. */
  size(): number {
    return this.queue.size;
  }

  /**
   * Process all retry records whose nextRetryAtMs has elapsed.
   *
   * For each due record:
   *   1. Increment attemptCount.
   *   2. Call attemptFn.  If accepted, remove from queue.
   *   3. If not accepted and attempts exhausted, call exhaustedFn and remove.
   *   4. Otherwise schedule the next retry.
   *
   * This method is idempotent and safe to call on a timer tick.
   */
  async tick(
    attemptFn: RetryAttemptFn,
    exhaustedFn: RetryExhaustedFn,
  ): Promise<void> {
    const now = Date.now();

    // Collect due records first to avoid mutating the map during iteration.
    const due: RetryRecord[] = [];
    for (const record of this.queue.values()) {
      if (now >= record.nextRetryAtMs) {
        due.push(record);
      }
    }

    for (const record of due) {
      // Message may have expired since it was queued.
      if (Date.parse(record.message.expiresAt) <= now) {
        this.queue.delete(record.messageId);
        continue;
      }

      record.attemptCount++;

      const result = await attemptFn(record);

      if (result.accepted) {
        this.queue.delete(record.messageId);
        continue;
      }

      if (record.attemptCount >= record.maxAttempts) {
        this.queue.delete(record.messageId);
        exhaustedFn(record);
        continue;
      }

      // Schedule next attempt.
      record.nextRetryAtMs = now + record.retryIntervalMs;
    }
  }

  /**
   * Start an internal timer that calls tick() automatically.
   *
   * @param attemptFn    Called for each due retry record.
   * @param exhaustedFn  Called when a record exhausts all attempts.
   * @param intervalMs   Timer interval.  Defaults to retryIntervalMs / 2 so
   *                     retries fire approximately on schedule.
   */
  start(
    attemptFn: RetryAttemptFn,
    exhaustedFn: RetryExhaustedFn,
    intervalMs?: number,
  ): void {
    if (this.timerId !== null) return;
    const interval = intervalMs ?? Math.max(100, this.retryIntervalMs / 2);
    this.timerId = setInterval(() => {
      void this.tick(attemptFn, exhaustedFn);
    }, interval);
  }

  /** Stop the internal retry timer. */
  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Stop the timer and drain the queue. */
  clear(): void {
    this.stop();
    this.queue.clear();
  }
}
