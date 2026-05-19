import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  __resetForTests,
  emitSessionExpired,
  resetCascade,
  subscribeSessionEvents,
} from "../auth-bridge";

// Each test starts from a clean slate.
beforeEach(() => {
  __resetForTests();
});

// Microtask drain helper.
async function drain(): Promise<void> {
  await new Promise<void>((r) => queueMicrotask(r));
}

test("subscribeSessionEvents delivers an emitted 'expired' event", async () => {
  const seen: string[] = [];
  subscribeSessionEvents((event) => seen.push(event));
  emitSessionExpired();
  await drain();
  assert.deepEqual(seen, ["expired"]);
});

test("emitSessionExpired de-duplicates concurrent calls (in-flight flag)", async () => {
  const seen: string[] = [];
  subscribeSessionEvents((event) => seen.push(event));
  emitSessionExpired();
  emitSessionExpired();
  emitSessionExpired();
  await drain();
  // All three emit calls dedup to one delivered event.
  assert.deepEqual(seen, ["expired"]);
});

test("resetCascade re-arms the in-flight flag", async () => {
  const seen: string[] = [];
  subscribeSessionEvents((event) => seen.push(event));

  emitSessionExpired();
  await drain();
  resetCascade();
  emitSessionExpired();
  await drain();

  assert.deepEqual(seen, ["expired", "expired"]);
});

test("unsubscribe stops further deliveries", async () => {
  const seen: string[] = [];
  const unsub = subscribeSessionEvents((event) => seen.push(event));
  unsub();

  emitSessionExpired();
  await drain();

  assert.deepEqual(seen, []);
});

test("multiple subscribers all receive the event", async () => {
  const calls: string[] = [];
  subscribeSessionEvents(() => calls.push("a"));
  subscribeSessionEvents(() => calls.push("b"));
  subscribeSessionEvents(() => calls.push("c"));

  emitSessionExpired();
  await drain();

  assert.deepEqual(calls.sort(), ["a", "b", "c"]);
});
