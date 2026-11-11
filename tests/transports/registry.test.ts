import test from "node:test";
import assert from "node:assert";
import { TransportRegistry } from "../../src/lib/network/registry";
import { SimulatorAdapter } from "../../src/lib/network/adapters/simulator-adapter";

test("registry: register and retrieve adapter", () => {
  const registry = new TransportRegistry();
  const sim = new SimulatorAdapter("sim-1");

  registry.register(sim);
  assert.strictEqual(registry.get("sim-1"), sim);
  assert.strictEqual(registry.list().length, 1);

  const health = registry.getHealth("sim-1");
  assert.ok(health);
  assert.strictEqual(health.state, "stopped");
  assert.strictEqual(health.txCount, 0);
  assert.strictEqual(health.rxCount, 0);
});

test("registry: reject duplicate adapter ID", () => {
  const registry = new TransportRegistry();
  registry.register(new SimulatorAdapter("sim-dup"));

  assert.throws(
    () => registry.register(new SimulatorAdapter("sim-dup")),
    /Transport already registered: sim-dup/
  );
});

test("registry: reject blank or whitespace adapter ID", () => {
  const registry = new TransportRegistry();
  assert.throws(
    () => registry.register(new SimulatorAdapter("   ")),
    /cannot be blank/
  );
});

test("registry: remove adapter and prune health records", () => {
  const registry = new TransportRegistry();
  registry.register(new SimulatorAdapter("sim-rem"));

  assert.strictEqual(registry.remove("sim-rem"), true);
  assert.strictEqual(registry.get("sim-rem"), undefined);
  assert.strictEqual(registry.getHealth("sim-rem"), undefined);
  assert.strictEqual(registry.remove("sim-rem"), false);
});

test("registry: track transmission and reception health", () => {
  const registry = new TransportRegistry();
  registry.register(new SimulatorAdapter("sim-health"));

  registry.updateState("sim-health", "ready");
  registry.recordTx("sim-health", true);
  registry.recordTx("sim-health", false, "Channel congested");
  registry.recordRx("sim-health");

  const health = registry.getHealth("sim-health");
  assert.ok(health);
  assert.strictEqual(health.state, "ready");
  assert.strictEqual(health.txCount, 1);
  assert.strictEqual(health.rxCount, 1);
  assert.strictEqual(health.lastError, "Channel congested");
  assert.ok(health.lastTransmittedAt);
  assert.ok(health.lastReceivedAt);
});
