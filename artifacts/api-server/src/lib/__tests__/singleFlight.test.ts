// SERVER-8 D (BUG-572) — lib/singleFlight: one call per key at a time, in this process.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSingleFlight } from "../singleFlight";

describe("SERVER-8 D — singleFlight", () => {
  it("a key's second caller while the first runs gets the first one's value; another key runs its own", async () => {
    const f = createSingleFlight<number>();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => { calls += 1; await gate; return calls; };
    const a = f.run("plan-1", slow);
    const b = f.run("plan-1", slow);
    const c = f.run("plan-2", slow);
    assert.equal(f.size, 2);
    release();
    assert.deepEqual(await a, { value: 2, shared: false });
    assert.deepEqual(await b, { value: 2, shared: true });
    assert.equal((await c).shared, false);
    assert.equal(calls, 2);
    assert.equal(f.size, 0);
  });

  it("once settled the key is free: the next call runs; a rejection reaches every waiter and frees it too", async () => {
    const f = createSingleFlight<string>();
    await f.run("k", async () => "first");
    assert.deepEqual(await f.run("k", async () => "second"), { value: "second", shared: false });
    const boom = async () => { throw new Error("narration failed"); };
    const [x, y] = await Promise.allSettled([f.run("k", boom), f.run("k", boom)]);
    assert.equal(x.status, "rejected");
    assert.equal(y.status, "rejected");
    assert.equal(f.size, 0);
    assert.equal((await f.run("k", async () => "again")).value, "again");
  });
});
