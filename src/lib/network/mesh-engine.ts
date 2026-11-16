/**
 * Phase 4 — Mesh Networking Engine
 *
 * MeshEngine sits on top of the Phase 3 TransportManager and adds:
 *   - Neighbor discovery and table management.
 *   - Dynamic routing table with multi-hop route selection.
 *   - Hop-by-hop packet forwarding with duplicate suppression.
 *   - Delivery acknowledgement messages (ACK) and timeout handling.
 *   - Retry manager with configurable limits and alternative route recovery.
 *
 * Design principles:
 *   - Completely independent of Next.js, React, and browser-specific APIs.
 *   - Extends TransportManager; does not replace it.
 *   - ACK messages are plain TransportMessages with a JSON payload discriminated
 *     by type: "GN_ACK_V1".  They travel through the same transport layer as
 *     data messages.
 *   - A node is its own destination — messages addressed to this node's ID are
 *     delivered locally rather than forwarded.
 */

import { TransportManager } from "./manager";
import { TransportRegistry } from "./registry";
import { DeduplicationCache } from "./deduplication";
import { NeighborTable } from "./neighbor-table";
import { RoutingTable } from "./routing-table";
import { AckTracker } from "./ack-tracker";
import { RetryManager } from "./retry-manager";
import { InMemoryMessageStore } from "./message-store";
import { encodeTransportPayload, decodeTransportPayload } from "./codec";
import type {
  AckPayload,
  AckRecord,
  ForwardDecision,
  MeshEngineConfig,
  MessageStore,
  NodeIdentity,
} from "./mesh-types";
import type { TransportMessage } from "./types";

// ---------------------------------------------------------------------------
// Public event types
// ---------------------------------------------------------------------------

export type MessageDeliveredHandler = (message: TransportMessage) => void;
export type AckReceivedHandler = (record: AckRecord) => void;
export type AckTimedOutHandler = (messageId: string, destinationId: string) => void;
export type RouteFailureHandler = (messageId: string, destinationId: string, reason: string) => void;
export type NeighborChangedHandler = (nodeId: string, event: "added" | "refreshed" | "expired") => void;

// ---------------------------------------------------------------------------
// MeshEngine
// ---------------------------------------------------------------------------

export class MeshEngine {
  readonly identity: NodeIdentity;

  private readonly manager: TransportManager;
  private readonly dedupCache: DeduplicationCache;
  private readonly neighbors: NeighborTable;
  private readonly routes: RoutingTable;
  private readonly ackTracker: AckTracker;
  private readonly retryManager: RetryManager;
  private readonly store: MessageStore;

  private readonly neighborTtlMs: number;
  private readonly ackTimeoutMs: number;

  // Event listeners
  private readonly deliveryListeners = new Set<MessageDeliveredHandler>();
  private readonly ackListeners = new Set<AckReceivedHandler>();
  private readonly ackTimeoutListeners = new Set<AckTimedOutHandler>();
  private readonly routeFailureListeners = new Set<RouteFailureHandler>();
  private readonly neighborListeners = new Set<NeighborChangedHandler>();

  // Cleanup handle for the inbound message subscription.
  private unsubscribeInbound: (() => void) | null = null;

  constructor(
    registry: TransportRegistry,
    config: MeshEngineConfig,
    store?: MessageStore,
  ) {
    this.identity = config.identity;
    this.manager = new TransportManager(registry);
    this.neighborTtlMs = config.neighborTtlMs ?? 60_000;
    this.ackTimeoutMs = config.ackTimeoutMs ?? 5_000;

    this.dedupCache = new DeduplicationCache(
      config.dedupCacheSize ?? 10_000,
    );
    this.neighbors = new NeighborTable(this.neighborTtlMs);
    this.routes = new RoutingTable();
    this.ackTracker = new AckTracker();
    this.retryManager = new RetryManager({
      maxAttempts: config.maxRetryAttempts ?? 3,
      retryIntervalMs: config.retryIntervalMs ?? 2_000,
    });
    this.store = store ?? new InMemoryMessageStore();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.manager.startAll();
    this.unsubscribeInbound = this.manager.onMessage((adapterId, message) => {
      this.handleInbound(adapterId, message);
    });
    this.retryManager.start(
      record => this.attemptRetry(record),
      record => this.onRetryExhausted(record),
    );
  }

  async stop(): Promise<void> {
    this.retryManager.stop();
    this.unsubscribeInbound?.();
    this.unsubscribeInbound = null;
    this.ackTracker.clear();
    await this.manager.stopAll();
  }

  /**
   * Expose the underlying TransportManager so callers can register adapters,
   * query health, or start/stop individual transports.
   */
  get transportManager(): TransportManager {
    return this.manager;
  }

  // ---------------------------------------------------------------------------
  // Neighbor Management
  // ---------------------------------------------------------------------------

  /**
   * Announce a neighbor to the engine.  Called by the simulator or a future
   * hardware discovery layer when a peer is detected.
   *
   * Also installs a direct route to that neighbor (1 hop via itself).
   */
  announceNeighbor(
    nodeId: string,
    adapterId: string,
    signalQuality = 1.0,
  ): void {
    const isNew = !this.neighbors.has(nodeId);

    // Determine transport kind from the adapter ID — direct registry lookup
    // is synchronous; we use a simple scan of the ready adapters list.
    // If not found assume simulator.
    const adapter = this.manager["registry"].get(adapterId);
    const transportKind = adapter?.kind ?? "simulator";

    this.neighbors.update(nodeId, adapterId, transportKind, signalQuality);

    // A direct neighbor is reachable in 1 hop via itself as next hop.
    this.routes.upsert(nodeId, nodeId, adapterId, {
      hopCount: 1,
      signalQuality,
      lastConfirmedAt: new Date().toISOString(),
    });

    const event = isNew ? "added" : "refreshed";
    this.neighborListeners.forEach(h => {
      try { h(nodeId, event); } catch { /* isolate */ }
    });
  }

  /**
   * Expire a neighbor manually (e.g. after a confirmed failure).
   * Marks all routes through that neighbor as inactive.
   */
  expireNeighbor(nodeId: string): void {
    this.neighbors.remove(nodeId);
    // Mark all routes that use this node as next hop as failed.
    for (const route of this.routes.allRoutes()) {
      if (route.nextHopId === nodeId) {
        this.routes.markFailed(route.destinationId, nodeId);
      }
    }
    this.neighborListeners.forEach(h => {
      try { h(nodeId, "expired"); } catch { /* isolate */ }
    });
  }

  listNeighbors() {
    return this.neighbors.list();
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /**
   * Send a message from this node.
   *
   * - If a direct route to destinationId exists, use it.
   * - Otherwise broadcast to all ready adapters.
   * - Optionally registers an ACK expectation.
   *
   * @param message         The TransportMessage to send.
   * @param requestAck      Whether to request a delivery ACK. Default false.
   * @returns               Accepted/reason from the transport layer.
   */
  async send(
    message: TransportMessage,
    requestAck = false,
  ): Promise<{ accepted: boolean; reason?: string }> {
    // Validate before anything touches the transport.
    if (Date.parse(message.expiresAt) <= Date.now()) {
      return { accepted: false, reason: "Message expired before send" };
    }
    if (message.hopCount >= message.maxHops) {
      return { accepted: false, reason: "Hop limit reached" };
    }

    const result = await this.routeAndSend(message);

    if (requestAck && message.destinationNodeId) {
      const destId = message.destinationNodeId;
      // Register ACK expectation regardless of initial send result.
      // Even a failed initial send should trigger the retry path.
      this.ackTracker.expect({
        messageId: message.messageId,
        destinationId: destId,
        enqueuedAtMs: Date.now(),
        timeoutMs: this.ackTimeoutMs,
        onAck: record => {
          this.ackListeners.forEach(h => { try { h(record); } catch { /* isolate */ } });
        },
        onTimeout: () => {
          this.ackTimeoutListeners.forEach(h => {
            try { h(message.messageId, destId); } catch { /* isolate */ }
          });
          // Queue for retry on timeout.
          const route = this.routes.bestRoute(destId);
          this.retryManager.enqueue(message, route?.adapterId ?? "");
        },
      });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Inbound handling
  // ---------------------------------------------------------------------------

  private handleInbound(adapterId: string, message: TransportMessage): void {
    // --- Duplicate suppression ---
    if (!this.dedupCache.add(message.messageId)) {
      return; // already processed
    }

    // --- Classify: ACK control message or data message ---
    if (this.isAckMessage(message)) {
      this.handleAck(message);
      return;
    }

    // --- Announce the source as a neighbor (refresh last-seen) ---
    if (message.sourceNodeId !== this.identity.nodeId) {
      this.announceNeighbor(message.sourceNodeId, adapterId);
    }

    // --- Routing decision ---
    const decision = this.forwardDecision(message);

    switch (decision.action) {
      case "deliver":
        this.deliverLocally(message);
        break;

      case "forward":
        this.forward(message, decision.nextHopId, decision.adapterId);
        break;

      case "drop":
        // Drop silently; the reason is available for diagnostics via tests.
        break;
    }
  }

  /**
   * Determine what to do with an inbound message.
   * Public for testing; not part of the stable external API.
   */
  forwardDecision(message: TransportMessage): ForwardDecision {
    // --- Expiry check ---
    if (Date.parse(message.expiresAt) <= Date.now()) {
      return { action: "drop", reason: "Message expired" };
    }

    // --- Addressed to this node ---
    const dest = message.destinationNodeId;
    if (!dest || dest === this.identity.nodeId || dest === "broadcast") {
      return { action: "deliver" };
    }

    // --- Hop limit check before forwarding ---
    const nextHopCount = message.hopCount + 1;
    if (nextHopCount >= message.maxHops) {
      return { action: "drop", reason: `Hop limit reached (${nextHopCount}/${message.maxHops})` };
    }

    // --- Route lookup ---
    const route = this.routes.bestRoute(dest);
    if (!route) {
      return { action: "drop", reason: `No route to ${dest}` };
    }

    return {
      action: "forward",
      nextHopId: route.nextHopId,
      adapterId: route.adapterId,
    };
  }

  private deliverLocally(message: TransportMessage): void {
    // Store for later retrieval.
    void this.store.put(
      message.messageId,
      message.payload,
      new Date().toISOString(),
    );

    // Emit to delivery listeners.
    this.deliveryListeners.forEach(h => {
      try { h(message); } catch { /* isolate */ }
    });

    // Send ACK back to the source if addressable.
    if (message.destinationNodeId === this.identity.nodeId && message.sourceNodeId) {
      void this.sendAck(message.messageId, message.sourceNodeId);
    }
  }

  private forward(
    message: TransportMessage,
    nextHopId: string,
    adapterId: string,
  ): void {
    const forwarded: TransportMessage = {
      ...message,
      hopCount: message.hopCount + 1,
      payload: new Uint8Array(message.payload),
    };

    void this.manager.send(adapterId, forwarded).then(result => {
      if (!result.accepted) {
        // Mark the route failed and try an alternative.
        const dest = message.destinationNodeId!;
        this.routes.markFailed(dest, nextHopId);
        const alt = this.routes.alternativeRoute(dest, nextHopId);
        if (alt) {
          this.routes.markRecovered(dest, alt.nextHopId);
          this.forward(message, alt.nextHopId, alt.adapterId);
        } else {
          this.routeFailureListeners.forEach(h => {
            try {
              h(message.messageId, dest, result.reason ?? "Forward failed, no alternative route");
            } catch { /* isolate */ }
          });
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ACK sending and handling
  // ---------------------------------------------------------------------------

  private async sendAck(originalMessageId: string, destinationId: string): Promise<void> {
    const ackPayload: AckPayload = {
      type: "GN_ACK_V1",
      originalMessageId,
      ackedBy: this.identity.nodeId,
      ackedAt: new Date().toISOString(),
    };

    const ackMessage: TransportMessage = {
      messageId: `ack-${originalMessageId}`,
      sourceNodeId: this.identity.nodeId,
      destinationNodeId: destinationId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      hopCount: 0,
      maxHops: 8,
      payload: encodeTransportPayload(ackPayload),
    };

    await this.routeAndSend(ackMessage);
  }

  private isAckMessage(message: TransportMessage): boolean {
    try {
      const payload = decodeTransportPayload<AckPayload>(message.payload);
      return (
        payload !== null &&
        typeof payload === "object" &&
        (payload as AckPayload).type === "GN_ACK_V1"
      );
    } catch {
      return false;
    }
  }

  private handleAck(message: TransportMessage): void {
    try {
      const payload = decodeTransportPayload<AckPayload>(message.payload);
      const record: AckRecord = {
        originalMessageId: payload.originalMessageId,
        ackedBy: payload.ackedBy,
        ackedAt: payload.ackedAt,
      };
      this.ackTracker.receive(record);

      // If we were retrying this message, cancel the retry.
      this.retryManager.remove(payload.originalMessageId);
    } catch {
      // Malformed ACK payload — drop silently.
    }
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  private async routeAndSend(
    message: TransportMessage,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const dest = message.destinationNodeId;

    // No specific destination — broadcast.
    if (!dest || dest === "broadcast") {
      const results = await this.manager.broadcast(message);
      const accepted = results.some(r => r.accepted);
      return {
        accepted,
        reason: accepted ? undefined : "No adapter accepted broadcast",
      };
    }

    // Check for a direct route.
    const route = this.routes.bestRoute(dest);
    if (route) {
      const result = await this.manager.send(route.adapterId, message);
      if (!result.accepted) {
        // Mark the route failed so the routing table reflects the failure.
        this.routes.markFailed(dest, route.nextHopId);
        this.routeFailureListeners.forEach(h => {
          try { h(message.messageId, dest, result.reason ?? "Send rejected"); } catch { /* isolate */ }
        });
      }
      return result;
    }

    // No route — fall back to broadcast and hope a relay picks it up.
    const results = await this.manager.broadcast(message);
    const accepted = results.some(r => r.accepted);
    return {
      accepted,
      reason: accepted ? undefined : `No route to ${dest} and broadcast failed`,
    };
  }

  // ---------------------------------------------------------------------------
  // Retry
  // ---------------------------------------------------------------------------

  private async attemptRetry(
    record: import("./mesh-types").RetryRecord,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const dest = record.destinationId;
    const failedAdapterId = record.adapterId;

    // Find an alternative route that is not through the previously failed adapter.
    const route = this.routes.alternativeRoute(dest, record.message.destinationNodeId ?? "");
    const adapterId = route?.adapterId ?? failedAdapterId;

    const retryMessage: TransportMessage = {
      ...record.message,
      payload: new Uint8Array(record.message.payload),
    };

    return this.manager.send(adapterId, retryMessage);
  }

  private onRetryExhausted(record: import("./mesh-types").RetryRecord): void {
    this.ackTracker.cancel(record.messageId);
    this.routeFailureListeners.forEach(h => {
      try {
        h(record.messageId, record.destinationId, "Retry limit exhausted");
      } catch { /* isolate */ }
    });
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  /** Subscribe to messages delivered to this node. */
  onDelivery(handler: MessageDeliveredHandler): () => void {
    this.deliveryListeners.add(handler);
    return () => this.deliveryListeners.delete(handler);
  }

  /** Subscribe to ACK receipts for messages sent by this node. */
  onAck(handler: AckReceivedHandler): () => void {
    this.ackListeners.add(handler);
    return () => this.ackListeners.delete(handler);
  }

  /** Subscribe to ACK timeouts. */
  onAckTimeout(handler: AckTimedOutHandler): () => void {
    this.ackTimeoutListeners.add(handler);
    return () => this.ackTimeoutListeners.delete(handler);
  }

  /** Subscribe to route failure events. */
  onRouteFailure(handler: RouteFailureHandler): () => void {
    this.routeFailureListeners.add(handler);
    return () => this.routeFailureListeners.delete(handler);
  }

  /** Subscribe to neighbor table changes. */
  onNeighborChanged(handler: NeighborChangedHandler): () => void {
    this.neighborListeners.add(handler);
    return () => this.neighborListeners.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  getRoutingTable(): RoutingTable {
    return this.routes;
  }

  getNeighborTable(): NeighborTable {
    return this.neighbors;
  }

  getAckTracker(): AckTracker {
    return this.ackTracker;
  }

  getRetryManager(): RetryManager {
    return this.retryManager;
  }

}
