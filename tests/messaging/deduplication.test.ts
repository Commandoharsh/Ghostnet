import test from "node:test";
import assert from "node:assert";
import {
  classifyEmergencyText,
  DeduplicationCache,
  validateTransportMessage
} from "../../src/lib/network/deduplication";
import type { TransportMessage } from "../../src/lib/network/types";

test("deduplication: unique IDs accepted and duplicates rejected", () => {
  const cache = new DeduplicationCache(100);

  assert.strictEqual(cache.add("msg-alpha-001"), true);
  assert.strictEqual(cache.has("msg-alpha-001"), true);
  assert.strictEqual(cache.add("msg-alpha-001"), false); // duplicate rejected
  assert.strictEqual(cache.size(), 1);
});

test("deduplication: cache respects TTL and prunes expired items", async () => {
  const cache = new DeduplicationCache(100, 50); // 50ms TTL

  cache.add("msg-short-lived", Date.now() + 30);
  assert.strictEqual(cache.has("msg-short-lived"), true);

  await new Promise(resolve => setTimeout(resolve, 45));

  assert.strictEqual(cache.has("msg-short-lived"), false);
  const pruned = cache.prune();
  assert.strictEqual(pruned, 0); // already removed on query
  assert.strictEqual(cache.size(), 0);
});

test("deduplication: cache enforces bounded capacity with oldest eviction", () => {
  const cache = new DeduplicationCache(3); // capacity 3

  cache.add("msg-1");
  cache.add("msg-2");
  cache.add("msg-3");
  assert.strictEqual(cache.size(), 3);

  cache.add("msg-4"); // triggers eviction of msg-1
  assert.strictEqual(cache.size(), 3);
  assert.strictEqual(cache.has("msg-1"), false);
  assert.strictEqual(cache.has("msg-4"), true);
});

test("validation: validateTransportMessage checks schema constraints", () => {
  const valid: TransportMessage = {
    messageId: "valid-message-id-001",
    sourceNodeId: "GN-SOURCE-001",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hopCount: 0,
    maxHops: 4,
    payload: new Uint8Array([1, 2, 3])
  };

  assert.strictEqual(validateTransportMessage(valid).valid, true);

  // Short ID
  const shortId = { ...valid, messageId: "short" };
  assert.strictEqual(validateTransportMessage(shortId).valid, false);

  // Negative hop count
  const negHop = { ...valid, hopCount: -1 };
  assert.strictEqual(validateTransportMessage(negHop).valid, false);

  // Hop limit reached
  const hopLimit = { ...valid, hopCount: 4, maxHops: 4 };
  assert.strictEqual(validateTransportMessage(hopLimit).valid, false);

  // Expired
  const expired = { ...valid, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.strictEqual(validateTransportMessage(expired).valid, false);

  // Empty payload
  const emptyPayload = { ...valid, payload: new Uint8Array(0) };
  assert.strictEqual(validateTransportMessage(emptyPayload).valid, false);
});

test("triage: classifyEmergencyText flags categories and human review", () => {
  const med = classifyEmergencyText("Patient is bleeding and requires ambulance immediately");
  assert.strictEqual(med.classification, "medical");
  assert.strictEqual(med.humanReviewRequired, true);

  const fire = classifyEmergencyText("Heavy smoke and fire spotted at sector 4");
  assert.strictEqual(fire.classification, "fire");
  assert.strictEqual(fire.humanReviewRequired, true);

  const rescue = classifyEmergencyText("People trapped under building collapse");
  assert.strictEqual(rescue.classification, "rescue");
  assert.strictEqual(rescue.humanReviewRequired, true);

  const regular = classifyEmergencyText("Routine logistics update. Radio check.");
  assert.strictEqual(regular.classification, "unclassified");
  assert.strictEqual(regular.humanReviewRequired, false);
});
