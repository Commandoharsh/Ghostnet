import test from "node:test";
import assert from "node:assert";
import { TransportRegistry } from "../../src/lib/network/registry";
import { TransportManager } from "../../src/lib/network/manager";
import { SimulatorAdapter } from "../../src/lib/network/adapters/simulator-adapter";
import type { TransportAdapter, TransportCapabilities, TransportMessage, TransportState } from "../../src/lib/network/types";

function createValidMessage(id = "msg-mgr-001"): TransportMessage {
  return {
    messageId: id,
    sourceNodeId: "GN-MANAGER-001",
    destinationNodeId: "broadcast",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hopCount: 0,
    maxHops: 5,
    payload: new Uint8Array([10, 20, 30])
  };
}

test("manager: startAll, stopAll and status query", async () => {
  const registry = new TransportRegistry();
  const sim1 = new SimulatorAdapter("sim-1");
  const sim2 = new SimulatorAdapter("sim-2");
  registry.register(sim1);
  registry.register(sim2);

  const manager = new TransportManager(registry);

  const startResults = await manager.startAll();
  assert.strictEqual(startResults.length, 2);
  assert.strictEqual(startResults.every(r => r.ok), true);

  const ready = await manager.getReadyAdapters();
  assert.strictEqual(ready.length, 2);

  await manager.stopAll();
  const readyAfterStop = await manager.getReadyAdapters();
  assert.strictEqual(readyAfterStop.length, 0);
});

test("manager: send validates hop limit", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-hop");
  registry.register(sim);
  const manager = new TransportManager(registry);
  await manager.startAdapter("sim-hop");

  const msg = createValidMessage();
  msg.hopCount = 5;
  msg.maxHops = 5; // hop limit reached

  const result = await manager.send("sim-hop", msg);
  assert.strictEqual(result.accepted, false);
  assert.match(result.reason ?? "", /Hop limit reached/);
});

test("manager: send validates MTU payload bounds", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-mtu");
  registry.register(sim);
  const manager = new TransportManager(registry);
  await manager.startAdapter("sim-mtu");

  const msg = createValidMessage();
  msg.payload = new Uint8Array(100 * 1024); // 100 KB > 64 KB capability

  const result = await manager.send("sim-mtu", msg);
  assert.strictEqual(result.accepted, false);
  assert.match(result.reason ?? "", /Payload exceeds limit/);
});

test("manager: broadcast isolates adapter failure", async () => {
  const registry = new TransportRegistry();
  const goodSim = new SimulatorAdapter("sim-good");
  registry.register(goodSim);

  // Faulty adapter that throws on send
  const faultyAdapter: TransportAdapter = {
    id: "faulty-radio",
    kind: "lora",
    capabilities: {
      maxPayloadBytes: 256,
      estimatedBandwidthBps: 1000,
      supportsBroadcast: true,
      supportsUnicast: true,
      supportsAcknowledgements: false,
      longRange: true
    },
    async initialize() {},
    async start() {},
    async stop() {},
    async send() {
      throw new Error("Hardware radio bus error (SPI timeout)");
    },
    onReceive() {
      return () => {};
    },
    async getStatus() {
      return "ready" as TransportState;
    }
  };
  registry.register(faultyAdapter);

  const manager = new TransportManager(registry);
  await manager.startAll();

  const msg = createValidMessage("msg-broadcast-iso");
  const results = await manager.broadcast(msg);

  assert.strictEqual(results.length, 2);
  const goodResult = results.find(r => r.adapterId === "sim-good");
  const badResult = results.find(r => r.adapterId === "faulty-radio");

  assert.ok(goodResult);
  assert.strictEqual(goodResult.accepted, true);

  assert.ok(badResult);
  assert.strictEqual(badResult.accepted, false);
  assert.match(badResult.reason ?? "", /Hardware radio bus error/);
});

test("manager: onMessage receives incoming transmissions across adapters", async () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-inbound");
  registry.register(sim);

  const manager = new TransportManager(registry);
  await manager.startAll();

  const inbound: Array<{ adapterId: string; message: TransportMessage }> = [];
  const unsubscribe = manager.onMessage((adapterId, message) => {
    inbound.push({ adapterId, message });
  });

  const msg = createValidMessage("msg-inbound-test");
  sim.receiveDirect(msg);

  assert.strictEqual(inbound.length, 1);
  assert.strictEqual(inbound[0].adapterId, "sim-inbound");
  assert.strictEqual(inbound[0].message.messageId, "msg-inbound-test");

  unsubscribe();
  sim.receiveDirect(createValidMessage("msg-inbound-after-unsub"));
  assert.strictEqual(inbound.length, 1); // no extra delivery after unsubscribe
});
