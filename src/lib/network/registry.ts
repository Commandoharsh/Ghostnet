import type { TransportAdapter } from "./types";

export class TransportRegistry {
  private readonly adapters = new Map<string, TransportAdapter>();
  register(adapter: TransportAdapter): void {
    if (!adapter.id.trim()) throw new Error("Transport adapter ID is required");
    if (this.adapters.has(adapter.id)) throw new Error(`Transport already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): TransportAdapter | undefined { return this.adapters.get(id); }
  list(): TransportAdapter[] { return [...this.adapters.values()]; }
  remove(id: string): boolean { return this.adapters.delete(id); }
}
