export type TransportKind = "lora" | "wifi" | "bluetooth" | "ethernet" | "simulator";

export type TransportState = "stopped" | "starting" | "ready" | "degraded" | "error";

export type DeliveryState = "accepted" | "transmitted" | "delivered" | "acknowledged";

export interface TransportCapabilities {
  maxPayloadBytes: number;
  estimatedBandwidthBps: number;
  supportsBroadcast: boolean;
  supportsUnicast: boolean;
  supportsAcknowledgements: boolean;
  longRange: boolean;
}

export interface TransportMessage {
  messageId: string;
  sourceNodeId: string;
  destinationNodeId?: string;
  payload: Uint8Array;
  createdAt: string;
  expiresAt: string;
  hopCount: number;
  maxHops: number;
}

export interface BroadcastResult {
  adapterId: string;
  accepted: boolean;
  reason?: string;
}

export interface AdapterHealth {
  state: TransportState;
  lastTransmittedAt?: string;
  lastReceivedAt?: string;
  lastError?: string;
  txCount: number;
  rxCount: number;
}

export interface DiscoveredPeer {
  nodeId: string;
  transportKind: TransportKind;
  adapterId: string;
  lastSeenAt: string;
  signalQuality?: number;
}

export interface PeerDiscovery {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPeerDiscovered(handler: (peer: DiscoveredPeer) => void): () => void;
  listPeers(): DiscoveredPeer[];
}

export interface PacketEnvelope {
  version: number;
  flags: number;
  messageId: string;
  sourceNodeId: string;
  destinationNodeId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  hopCount: number;
  maxHops: number;
  payload: Uint8Array;
}

export interface TransportAdapter {
  readonly id: string;
  readonly kind: TransportKind;
  readonly capabilities: TransportCapabilities;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: TransportMessage): Promise<{ accepted: boolean; reason?: string }>;
  onReceive(handler: (message: TransportMessage) => void): () => void;
  getStatus(): Promise<TransportState>;
}

export interface NetworkSnapshot {
  generatedAt: string;
  mode: "simulation";
  nodes: Array<{ id: string; label: string; status: "online" | "degraded" | "offline"; transport: TransportKind; lastSeenAt: string }>;
  links: Array<{ source: string; target: string; transport: TransportKind; quality: number; simulated: true }>;
}
