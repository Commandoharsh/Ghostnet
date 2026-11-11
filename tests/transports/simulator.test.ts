import test from "node:test";
import assert from "node:assert";
import { SimulatorAdapter } from "../../src/lib/network/adapters/simulator-adapter";
import type { TransportMessage } from "../../src/lib/network/types";

function createTestMessage(id = "msg-sim-001", expiryMsOffset = 60_000): TransportMessage {
  return {
    messageId: id,
    sourceNodeId: "GN-001",
    destinationNodeId: "GN-002",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiryMsOffset).toISOString(),
    hopCount: 0,
    maxHops: 3,
    payload: new Uint8Array([1, 2, 3, 4])
  };
}

test("simulator: lifecycle state transitions", async () => {
  const sim = new SimulatorAdapter("sim-life");
  assert.strictEqual(await sim.getStatus(), "stopped");

  await sim.initialize();
  assert.strictEqual(await sim.getStatus(), "starting");

  await sim.start();
  assert.strictEqual(await sim.getStatus(), "ready");

  await sim.stop();
  assert.strictEqual(await sim.getStatus(), "stopped");
});

test("simulator: reject send when not in ready state", async () => {
  const sim = new SimulatorAdapter("sim-not-ready");
  const msg = createTestMessage();

  const res = await sim.send(msg);
  assert.strictEqual(res.accepted, false);
  assert.match(res.reason ?? "", /not in ready state/);
});

test("simulator: reject send when message is expired", async () => {
  const sim = new SimulatorAdapter("sim-exp");
  await sim.start();

  const expiredMsg = createTestMessage("msg-expired", -10_000);
  const res = await sim.send(expiredMsg);
  assert.strictEqual(res.accepted, false);
  assert.match(res.reason ?? "", /Message expired/);
});

test("simulator: deliver to local onReceive handler", async () => {
  const sim = new SimulatorAdapter("sim-recv");
  await sim.start();

  const received: TransportMessage[] = [];
  const unsubscribe = sim.onReceive(msg => received.push(msg));

  const msg = createTestMessage("msg-deliver-001");
  const res = await sim.send(msg);
  assert.strictEqual(res.accepted, true);

  // Wait a microtask tick for async delivery
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].messageId, "msg-deliver-001");

  unsubscribe();
  const msg2 = createTestMessage("msg-deliver-002");
  await sim.send(msg2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(received.length, 1); // no additional message received after unsubscribe
});

test("simulator: virtual peer link between Node A and Node B", async () => {
  const nodeA = new SimulatorAdapter("sim-node-a");
  const nodeB = new SimulatorAdapter("sim-node-b");

  await nodeA.start();
  await nodeB.start();

  const disconnect = nodeA.connectPeer(nodeB);

  const nodeBReceived: TransportMessage[] = [];
  nodeB.onReceive(msg => nodeBReceived.push(msg));

  const msg = createTestMessage("msg-peer-transmission");
  const res = await nodeA.send(msg);
  assert.strictEqual(res.accepted, true);

  await new Promise(resolve => setTimeout(resolve, 30));

  assert.strictEqual(nodeBReceived.length, 1);
  assert.strictEqual(nodeBReceived[0].messageId, "msg-peer-transmission");

  disconnect();
});

test("simulator: loop prevention suppresses duplicate incoming messages", async () => {
  const node = new SimulatorAdapter("sim-loop");
  await node.start();

  let count = 0;
  node.onReceive(() => count++);

  const msg = createTestMessage("msg-duplicate-loop");
  node.receiveDirect(msg);
  node.receiveDirect(msg); // duplicate delivery

  assert.strictEqual(count, 1); // second delivery was suppressed
});
