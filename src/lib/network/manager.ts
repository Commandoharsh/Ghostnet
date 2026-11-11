import type { BroadcastResult, TransportAdapter, TransportMessage, TransportState } from "./types";
import { TransportRegistry } from "./registry";

export type MessageHandler = (adapterId: string, message: TransportMessage) => void;

export class TransportManager {
  private readonly messageListeners = new Set<MessageHandler>();
  private readonly adapterSubscriptions = new Map<string, () => void>();

  constructor(private readonly registry: TransportRegistry) {}

  /**
   * Subscribe to incoming messages received across any active adapter.
   * Returns a leak-free unsubscribe callback.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageListeners.add(handler);
    return () => {
      this.messageListeners.delete(handler);
    };
  }

  private dispatchInbound(adapterId: string, message: TransportMessage): void {
    this.registry.recordRx(adapterId);
    this.messageListeners.forEach(listener => {
      try {
        listener(adapterId, message);
      } catch {
        // Listener errors must not crash the dispatch pipeline
      }
    });
  }

  private hookAdapterReceiver(adapter: TransportAdapter): void {
    if (this.adapterSubscriptions.has(adapter.id)) {
      this.adapterSubscriptions.get(adapter.id)?.();
    }
    const unsubscribe = adapter.onReceive(message => {
      this.dispatchInbound(adapter.id, message);
    });
    this.adapterSubscriptions.set(adapter.id, unsubscribe);
  }

  async startAdapter(id: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.registry.get(id);
    if (!adapter) {
      return { ok: false, error: `Transport adapter not found: ${id}` };
    }
    try {
      this.registry.updateState(id, "starting");
      await adapter.initialize();
      await adapter.start();
      this.registry.updateState(id, "ready");
      this.hookAdapterReceiver(adapter);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Transport startup failed";
      this.registry.updateState(id, "error", msg);
      return { ok: false, error: msg };
    }
  }

  async stopAdapter(id: string): Promise<void> {
    const adapter = this.registry.get(id);
    if (!adapter) return;

    const unsubscribe = this.adapterSubscriptions.get(id);
    if (unsubscribe) {
      unsubscribe();
      this.adapterSubscriptions.delete(id);
    }

    try {
      await adapter.stop();
      this.registry.updateState(id, "stopped");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Transport shutdown failed";
      this.registry.updateState(id, "error", msg);
    }
  }

  async startAll(): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const adapters = this.registry.list();
    return Promise.all(
      adapters.map(async adapter => {
        const result = await this.startAdapter(adapter.id);
        return { id: adapter.id, ...result };
      })
    );
  }

  async stopAll(): Promise<void> {
    const adapters = this.registry.list();
    await Promise.all(adapters.map(adapter => this.stopAdapter(adapter.id)));
  }

  async send(adapterId: string, message: TransportMessage): Promise<{ accepted: boolean; reason?: string }> {
    const adapter = this.registry.get(adapterId);
    if (!adapter) {
      return { accepted: false, reason: "Transport not registered" };
    }

    const state = await adapter.getStatus();
    if (state !== "ready") {
      this.registry.recordTx(adapterId, false, `Transport is in ${state} state`);
      return { accepted: false, reason: `Transport is in ${state} state` };
    }

    if (message.hopCount < 0 || message.maxHops < 1 || message.hopCount >= message.maxHops) {
      return { accepted: false, reason: "Hop limit reached" };
    }

    if (Date.parse(message.expiresAt) <= Date.now()) {
      return { accepted: false, reason: "Message expired" };
    }

    if (message.payload.byteLength > adapter.capabilities.maxPayloadBytes) {
      return { accepted: false, reason: `Payload exceeds limit of ${adapter.capabilities.maxPayloadBytes} bytes` };
    }

    try {
      const result = await adapter.send(message);
      this.registry.recordTx(adapterId, result.accepted, result.reason);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Transport send failed";
      this.registry.recordTx(adapterId, false, msg);
      return { accepted: false, reason: msg };
    }
  }

  /**
   * Broadcast a message across all ready adapters that support broadcasting.
   * Isolates failures so that an error on one transport does not block others.
   */
  async broadcast(message: TransportMessage): Promise<BroadcastResult[]> {
    const adapters = this.registry.list();
    const broadcastCapable = adapters.filter(a => a.capabilities.supportsBroadcast);

    if (!broadcastCapable.length) {
      return [];
    }

    const promises = broadcastCapable.map(async (adapter): Promise<BroadcastResult> => {
      const sendResult = await this.send(adapter.id, message);
      return {
        adapterId: adapter.id,
        accepted: sendResult.accepted,
        reason: sendResult.reason
      };
    });

    return Promise.all(promises);
  }

  async getStatus(adapterId: string): Promise<TransportState | undefined> {
    const adapter = this.registry.get(adapterId);
    if (!adapter) return undefined;
    return adapter.getStatus();
  }

  async getReadyAdapters(): Promise<TransportAdapter[]> {
    const adapters = this.registry.list();
    const ready: TransportAdapter[] = [];
    for (const a of adapters) {
      if ((await a.getStatus()) === "ready") {
        ready.push(a);
      }
    }
    return ready;
  }
}
