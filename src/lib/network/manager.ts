import type { TransportAdapter, TransportMessage } from "./types";
import { TransportRegistry } from "./registry";

export class TransportManager {
  constructor(private readonly registry: TransportRegistry) {}
  async startAll(): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    return Promise.all(this.registry.list().map(async adapter => {
      try { await adapter.initialize(); await adapter.start(); return { id: adapter.id, ok: true }; }
      catch (error) { return { id: adapter.id, ok: false, error: error instanceof Error ? error.message : "Unknown transport error" }; }
    }));
  }
  async stopAll(): Promise<void> {
    await Promise.all(this.registry.list().map(async adapter => { try { await adapter.stop(); } catch { /* isolate adapter shutdown failures */ } }));
  }
  async send(adapterId: string, message: TransportMessage): Promise<{ accepted: boolean; reason?: string }> {
    const adapter = this.registry.get(adapterId);
    if (!adapter) return { accepted: false, reason: "Transport not registered" };
    if (message.hopCount < 0 || message.maxHops < 1 || message.hopCount >= message.maxHops) return { accepted: false, reason: "Hop limit reached" };
    if (Date.parse(message.expiresAt) <= Date.now()) return { accepted: false, reason: "Message expired" };
    if (message.payload.byteLength > adapter.capabilities.maxPayloadBytes) return { accepted: false, reason: "Payload exceeds transport limit; fragmentation required" };
    try { return await adapter.send(message); }
    catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Transport send failed" }; }
  }
}
