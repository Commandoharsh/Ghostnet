import type { TransportAdapter, TransportCapabilities, TransportMessage, TransportState } from "../types";

export class SimulatorAdapter implements TransportAdapter {
  readonly id: string;
  readonly kind = "simulator" as const;
  readonly capabilities: TransportCapabilities = {
    maxPayloadBytes: 64 * 1024, estimatedBandwidthBps: 10_000_000,
    supportsBroadcast: true, supportsUnicast: true, supportsAcknowledgements: true, longRange: false
  };
  private state: TransportState = "stopped";
  private handlers = new Set<(message: TransportMessage) => void>();
  constructor(id = "simulator-local") { this.id = id; }
  async initialize(): Promise<void> { this.state = "starting"; }
  async start(): Promise<void> { this.state = "ready"; }
  async stop(): Promise<void> { this.state = "stopped"; }
  async send(message: TransportMessage): Promise<{ accepted: boolean; reason?: string }> {
    if (this.state !== "ready") return { accepted: false, reason: "Simulator is not running" };
    if (Date.parse(message.expiresAt) <= Date.now()) return { accepted: false, reason: "Message expired" };
    const copy: TransportMessage = { ...message, payload: new Uint8Array(message.payload) };
    queueMicrotask(() => this.handlers.forEach(handler => handler(copy)));
    return { accepted: true };
  }
  onReceive(handler: (message: TransportMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async getStatus(): Promise<TransportState> { return this.state; }
}
