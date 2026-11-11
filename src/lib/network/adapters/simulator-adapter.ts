import type { TransportAdapter, TransportCapabilities, TransportMessage, TransportState } from "../types";

export interface SimulatorPeerLinkOptions {
  dropRate?: number; // 0.0 to 1.0
  latencyMs?: number;
}

interface PeerConnection {
  peer: SimulatorAdapter;
  options: SimulatorPeerLinkOptions;
}

export class SimulatorAdapter implements TransportAdapter {
  readonly id: string;
  readonly kind = "simulator" as const;
  readonly capabilities: TransportCapabilities = {
    maxPayloadBytes: 64 * 1024,
    estimatedBandwidthBps: 10_000_000,
    supportsBroadcast: true,
    supportsUnicast: true,
    supportsAcknowledgements: true,
    longRange: false
  };

  private state: TransportState = "stopped";
  private handlers = new Set<(message: TransportMessage) => void>();
  private peerConnections = new Map<string, PeerConnection>();
  private seenMessages = new Map<string, number>(); // messageId -> timestamp ms

  public dropRate = 0; // 0.0 to 1.0
  public simulatedLatencyMs = 0;

  constructor(id = "simulator-local") {
    this.id = id;
  }

  async initialize(): Promise<void> {
    this.state = "starting";
  }

  async start(): Promise<void> {
    this.state = "ready";
  }

  async stop(): Promise<void> {
    this.state = "stopped";
  }

  async getStatus(): Promise<TransportState> {
    return this.state;
  }

  onReceive(handler: (message: TransportMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Establishes a virtual bidirectional peer connection to another SimulatorAdapter.
   * Returns an unsubscribe function to disconnect the peer link.
   */
  connectPeer(peer: SimulatorAdapter, options: SimulatorPeerLinkOptions = {}): () => void {
    this.peerConnections.set(peer.id, { peer, options });
    peer.peerConnections.set(this.id, { peer: this, options });

    return () => {
      this.peerConnections.delete(peer.id);
      peer.peerConnections.delete(this.id);
    };
  }

  /**
   * Directly injects a message into this adapter as an incoming transmission from the network/radio.
   */
  receiveDirect(message: TransportMessage): void {
    if (this.state !== "ready") return;
    this.pruneSeen();

    // Loop prevention: suppress already seen packets
    if (this.seenMessages.has(message.messageId)) {
      return;
    }
    this.seenMessages.set(message.messageId, Date.now());

    const copy: TransportMessage = {
      ...message,
      payload: new Uint8Array(message.payload)
    };

    this.handlers.forEach(handler => {
      try {
        handler(copy);
      } catch {
        // Handler errors must not crash the simulator
      }
    });
  }

  async send(message: TransportMessage): Promise<{ accepted: boolean; reason?: string }> {
    if (this.state !== "ready") {
      return { accepted: false, reason: "Simulator is not in ready state" };
    }
    if (Date.parse(message.expiresAt) <= Date.now()) {
      return { accepted: false, reason: "Message expired" };
    }
    if (message.payload.byteLength > this.capabilities.maxPayloadBytes) {
      return { accepted: false, reason: `Payload exceeds limit (${this.capabilities.maxPayloadBytes} bytes)` };
    }

    // Apply local drop rate simulation
    if (this.dropRate > 0 && Math.random() < this.dropRate) {
      return { accepted: true, reason: "Simulated packet drop on sender" };
    }

    this.pruneSeen();
    this.seenMessages.set(message.messageId, Date.now());

    const dispatchCopy = (): void => {
      const copy: TransportMessage = {
        ...message,
        payload: new Uint8Array(message.payload)
      };

      // 1. Deliver to local loopback handlers if applicable
      if (!this.peerConnections.size) {
        this.handlers.forEach(handler => {
          try {
            handler(copy);
          } catch {
            // Handler errors isolated
          }
        });
      }

      // 2. Deliver to connected peer simulator nodes
      for (const { peer, options } of this.peerConnections.values()) {
        const linkDropRate = options.dropRate ?? 0;
        if (linkDropRate > 0 && Math.random() < linkDropRate) {
          continue; // dropped on link
        }

        const linkLatency = options.latencyMs ?? 0;
        if (linkLatency > 0) {
          setTimeout(() => peer.receiveDirect(copy), linkLatency);
        } else {
          queueMicrotask(() => peer.receiveDirect(copy));
        }
      }
    };

    if (this.simulatedLatencyMs > 0) {
      setTimeout(dispatchCopy, this.simulatedLatencyMs);
    } else {
      queueMicrotask(dispatchCopy);
    }

    return { accepted: true };
  }

  private pruneSeen(): void {
    const cutoff = Date.now() - 60_000; // retain 60 seconds of history
    for (const [id, time] of this.seenMessages.entries()) {
      if (time < cutoff) {
        this.seenMessages.delete(id);
      }
    }
  }
}
