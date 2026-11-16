/**
 * Phase 4 — Mesh Networking Engine Types
 *
 * All types are pure TypeScript with no browser, Next.js, or React imports.
 * They extend and compose the Phase 3 transport contracts from types.ts.
 */

import type { TransportKind } from "./types";

// ---------------------------------------------------------------------------
// Node Identity
// ---------------------------------------------------------------------------

/**
 * Minimal identity record for a node in the mesh.
 *
 * NOTE: Cryptographic authentication is NOT implemented in Phase 4.
 * The nodeId is a plain string.  Authenticated identity using Ed25519
 * key pairs is planned for Phase 11.
 */
export interface NodeIdentity {
  /** Stable, human-readable node identifier (e.g. "GN-NODE-ALPHA"). */
  readonly nodeId: string;
  /**
   * Optional human-readable label for display (e.g. "Command center").
   * Not used for routing decisions.
   */
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Neighbor Table
// ---------------------------------------------------------------------------

export interface NeighborEntry {
  /** Node ID of the discovered neighbor. */
  nodeId: string;
  /** Transport kind through which the neighbor was last seen. */
  transportKind: TransportKind;
  /** Adapter ID of the local transport that sees this neighbor. */
  adapterId: string;
  /** ISO 8601 UTC timestamp of the last heard-from time. */
  lastSeenAt: string;
  /**
   * Estimated signal quality: 0.0 (no signal) to 1.0 (perfect).
   * Used as a tiebreaker in route selection.
   * Absent when no signal data is available.
   */
  signalQuality?: number;
}

// ---------------------------------------------------------------------------
// Routing Table
// ---------------------------------------------------------------------------

export type RouteMetric = {
  /** Number of hops to reach the destination via this route. */
  hopCount: number;
  /**
   * Estimated signal quality of the next-hop link (0.0–1.0).
   * Higher is better.
   */
  signalQuality: number;
  /** ISO 8601 UTC timestamp of when this route was last confirmed reachable. */
  lastConfirmedAt: string;
};

export interface RouteEntry {
  /** Final destination node ID. */
  destinationId: string;
  /** Next-hop node ID on the path to the destination. */
  nextHopId: string;
  /** Adapter ID to use for transmission toward the next hop. */
  adapterId: string;
  /** Routing metrics for this entry. */
  metric: RouteMetric;
  /**
   * Whether this route is currently considered usable.
   * Set to false on forwarding failure; recovered when an alternative is found.
   */
  active: boolean;
}

// ---------------------------------------------------------------------------
// Message Store Interface
// ---------------------------------------------------------------------------

/**
 * Abstract persistent store for mesh-layer messages.
 *
 * Phase 4 ships with an in-memory implementation.
 * Phase 12 will replace it with a SQLite-backed store.
 */
export interface MessageStore {
  /**
   * Store a received message.  Implementations must be idempotent:
   * storing the same messageId twice is a no-op.
   */
  put(messageId: string, payload: Uint8Array, receivedAt: string): Promise<void>;

  /** Returns true if a message with this ID has been stored. */
  has(messageId: string): Promise<boolean>;

  /** Retrieve stored payload bytes, or undefined if not found. */
  get(messageId: string): Promise<Uint8Array | undefined>;

  /**
   * Remove all messages whose receivedAt is before the given ISO timestamp.
   * Returns the number of records deleted.
   */
  purgeExpiredBefore(isoTimestamp: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// ACK Tracking
// ---------------------------------------------------------------------------

export interface AckRecord {
  /** ID of the original message being acknowledged. */
  originalMessageId: string;
  /** Node that sent the ACK. */
  ackedBy: string;
  /** ISO 8601 UTC timestamp of when the ACK was received. */
  ackedAt: string;
}

export interface PendingAck {
  /** Original message ID awaiting acknowledgement. */
  messageId: string;
  /** Destination node the message was sent to. */
  destinationId: string;
  /** Monotonic timestamp (ms) when the pending entry was created. */
  enqueuedAtMs: number;
  /** Timeout in ms after which the ACK is considered failed. */
  timeoutMs: number;
  /** Callback to invoke on ACK receipt. */
  onAck: (record: AckRecord) => void;
  /** Callback to invoke on timeout. */
  onTimeout: () => void;
}

// ---------------------------------------------------------------------------
// ACK Message payload schema
// ---------------------------------------------------------------------------

/**
 * JSON payload schema for ACK control messages transported over TransportMessage.
 * The mesh engine encodes this as the payload bytes of a TransportMessage with
 * destinationNodeId set to the original sender.
 */
export interface AckPayload {
  /** Discriminator: always "GN_ACK_V1". */
  type: "GN_ACK_V1";
  /** ID of the message being acknowledged. */
  originalMessageId: string;
  /** Node sending the ACK. */
  ackedBy: string;
  /** ISO 8601 UTC timestamp. */
  ackedAt: string;
}

// ---------------------------------------------------------------------------
// Retry Manager
// ---------------------------------------------------------------------------

export interface RetryRecord {
  /** Message ID subject to retry. */
  messageId: string;
  /** Serialised TransportMessage for re-transmission. */
  message: Readonly<import("./types").TransportMessage>;
  /** Adapter ID of the preferred route when the retry was queued. */
  adapterId: string;
  /** Destination node ID. */
  destinationId: string;
  /** Number of attempts made so far (not counting the original send). */
  attemptCount: number;
  /** Maximum number of retry attempts allowed. */
  maxAttempts: number;
  /** Delay in ms between retry attempts. */
  retryIntervalMs: number;
  /** Monotonic timestamp (ms) when the next retry is due. */
  nextRetryAtMs: number;
}

// ---------------------------------------------------------------------------
// Mesh Engine Configuration
// ---------------------------------------------------------------------------

export interface MeshEngineConfig {
  /** This node's identity. */
  identity: NodeIdentity;
  /**
   * How long in ms a neighbor entry remains valid without a fresh heartbeat.
   * Default: 60 000 ms (1 minute).
   */
  neighborTtlMs?: number;
  /**
   * Maximum number of retry attempts per message before giving up.
   * Default: 3.
   */
  maxRetryAttempts?: number;
  /**
   * Delay between retry attempts in ms.
   * Default: 2 000 ms.
   */
  retryIntervalMs?: number;
  /**
   * Timeout in ms to wait for a delivery ACK before triggering a retry.
   * Default: 5 000 ms.
   */
  ackTimeoutMs?: number;
  /**
   * Maximum number of message IDs tracked by the deduplication cache.
   * Default: 10 000.
   */
  dedupCacheSize?: number;
}

// ---------------------------------------------------------------------------
// Forwarding Decision
// ---------------------------------------------------------------------------

export type ForwardDecision =
  | { action: "deliver" }
  | { action: "forward"; nextHopId: string; adapterId: string }
  | { action: "drop"; reason: string };
