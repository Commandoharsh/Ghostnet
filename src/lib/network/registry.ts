import type { AdapterHealth, TransportAdapter, TransportState } from "./types";

export class TransportRegistry {
  private readonly adapters = new Map<string, TransportAdapter>();
  private readonly healthRecords = new Map<string, AdapterHealth>();

  register(adapter: TransportAdapter): void {
    const id = adapter.id?.trim();
    if (!id) {
      throw new Error("Transport adapter ID is required and cannot be blank");
    }
    if (this.adapters.has(id)) {
      throw new Error(`Transport already registered: ${id}`);
    }
    this.adapters.set(id, adapter);
    this.healthRecords.set(id, {
      state: "stopped",
      txCount: 0,
      rxCount: 0
    });
  }

  get(id: string): TransportAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): TransportAdapter[] {
    return [...this.adapters.values()];
  }

  remove(id: string): boolean {
    const deleted = this.adapters.delete(id);
    this.healthRecords.delete(id);
    return deleted;
  }

  getHealth(id: string): AdapterHealth | undefined {
    const record = this.healthRecords.get(id);
    return record ? { ...record } : undefined;
  }

  getAllHealth(): Map<string, AdapterHealth> {
    const copy = new Map<string, AdapterHealth>();
    for (const [id, health] of this.healthRecords.entries()) {
      copy.set(id, { ...health });
    }
    return copy;
  }

  updateState(id: string, state: TransportState, error?: string): void {
    const health = this.healthRecords.get(id);
    if (!health) return;
    health.state = state;
    if (error !== undefined) {
      health.lastError = error;
    }
  }

  recordTx(id: string, ok: boolean, error?: string): void {
    const health = this.healthRecords.get(id);
    if (!health) return;
    if (ok) {
      health.txCount += 1;
      health.lastTransmittedAt = new Date().toISOString();
    } else {
      health.lastError = error ?? "Transmission failed";
    }
  }

  recordRx(id: string): void {
    const health = this.healthRecords.get(id);
    if (!health) return;
    health.rxCount += 1;
    health.lastReceivedAt = new Date().toISOString();
  }
}
