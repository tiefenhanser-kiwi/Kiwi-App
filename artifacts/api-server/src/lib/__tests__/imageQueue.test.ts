// Row 5 · Block 1c (D-WS9-248) — the drain's state machine over an in-memory
// ImageQueueStore. What is pinned here: ready writes url + provenance and
// stamps the waiting forks; an OpenAI failure is a STRIKE (pending until the
// third, then failed and the pending forks fail with it); a spend-guard
// refusal / missing key is a DEFERRAL (pending, attempt undone, no strike);
// a store throw is a strike; a throw past the pipeline never leaves a row
// `generating`; the batch runs in parallel; an empty claim is a no-op.
//
// The atomic claim itself (advisory lock + FOR UPDATE SKIP LOCKED + the
// ledger budget) is raw SQL and is proven against the real database by
// scripts/ws9-row5/claim_race.ts, not here — the suite is hermetic.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Jimp } from "jimp";

import { ImageStore } from "../images/imageStore";
import {
  IMAGE_DRAIN_BATCH,
  IMAGE_MAX_ATTEMPTS,
  runImageDrain,
  type ClaimedImageRow,
  type ImageQueueStore,
  type ReleaseOutcome,
} from "../images/imageQueue";
import type { ImageFetch, ImageFetchResponse, ObjectWriter } from "../images/types";

interface MemRow {
  id: string;
  title: string;
  userId: string | null;
  imageUrl: string | null;
  imageStatus: "pending" | "generating" | "ready" | "failed";
  imageAttempts: number;
  sourceStoreMealId: string | null;
}

class MemoryQueueStore implements ImageQueueStore {
  rows = new Map<string, MemRow>();
  releases: Array<{ id: string; outcome: ReleaseOutcome }> = [];
  constructor(rows: MemRow[]) {
    for (const r of rows) this.rows.set(r.id, { ...r });
  }
  // FIFO in insertion order; a fork of a pending/generating parent waits.
  async claim(batch: number) {
    const claimed: ClaimedImageRow[] = [];
    for (const r of this.rows.values()) {
      if (claimed.length >= batch) break;
      if (r.imageStatus !== "pending" || r.imageAttempts >= IMAGE_MAX_ATTEMPTS) continue;
      const parent = r.sourceStoreMealId ? this.rows.get(r.sourceStoreMealId) : undefined;
      if (parent && (parent.imageStatus === "pending" || parent.imageStatus === "generating")) continue;
      r.imageStatus = "generating";
      r.imageAttempts++;
      claimed.push({ id: r.id, title: r.title, userId: r.userId, imageAttempts: r.imageAttempts });
    }
    return { claimed, requeuedStuck: 0, failedOut: 0, budget: { recentSends: 0, inFlight: 0, limit: batch } };
  }
  async loadSubjects(ids: string[]) {
    return ids.map((id) => ({ mealId: id, title: this.rows.get(id)!.title, dishTitles: [] }));
  }
  async markReady(id: string, url: string) {
    const r = this.rows.get(id)!;
    r.imageUrl = url;
    r.imageStatus = "ready";
    let forksStamped = 0;
    for (const f of this.rows.values()) {
      if (f.sourceStoreMealId === id && f.imageUrl === null && f.imageStatus === "pending") {
        f.imageUrl = url;
        f.imageStatus = "ready";
        forksStamped++;
      }
    }
    return { forksStamped };
  }
  async release(row: ClaimedImageRow, outcome: ReleaseOutcome) {
    this.releases.push({ id: row.id, outcome });
    const r = this.rows.get(row.id)!;
    if (outcome === "defer") {
      r.imageStatus = "pending";
      r.imageAttempts--;
      return "pending" as const;
    }
    const exhausted = row.imageAttempts >= IMAGE_MAX_ATTEMPTS;
    r.imageStatus = exhausted ? "failed" : "pending";
    if (exhausted) {
      for (const f of this.rows.values()) {
        if (f.sourceStoreMealId === row.id && f.imageUrl === null && f.imageStatus === "pending") f.imageStatus = "failed";
      }
    }
    return exhausted ? ("failed" as const) : ("pending" as const);
  }
}

class MemoryWriter implements ObjectWriter {
  saved: string[] = [];
  failWith: Error | null = null;
  async save(key: string) {
    if (this.failWith) throw this.failWith;
    this.saved.push(key);
  }
}

function row(id: string, over: Partial<MemRow> = {}): MemRow {
  return { id, title: `Meal ${id}`, userId: "u1", imageUrl: null, imageStatus: "pending", imageAttempts: 0, sourceStoreMealId: null, ...over };
}

async function png(): Promise<Buffer> {
  return new Jimp({ width: 64, height: 64, color: 0x336699ff }).getBuffer("image/png");
}

// The OpenAI stub: `mode` per call. Records the userIds the ledger would see.
function openaiStub(big: Buffer, mode: (n: number) => "ok" | "http500") {
  let calls = 0;
  const inFlight = { now: 0, peak: 0 };
  const fetch: ImageFetch = async () => {
    const n = ++calls;
    inFlight.now++;
    inFlight.peak = Math.max(inFlight.peak, inFlight.now);
    await new Promise((r) => setTimeout(r, 15));
    inFlight.now--;
    const m = mode(n);
    const res: ImageFetchResponse = {
      ok: m === "ok",
      status: m === "ok" ? 200 : 500,
      headers: { get: () => "application/json" },
      json: async () => (m === "ok" ? { data: [{ b64_json: big.toString("base64") }], usage: { input_tokens: 5, output_tokens: 100 } } : { error: { message: "boom" } }),
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => "",
    };
    return res;
  };
  return { fetch, calls: () => calls, inFlight };
}

function pipeline(fetch: ImageFetch, writer: ObjectWriter, apiKey = "sk-test") {
  return { fetch, generator: { apiKey }, store: new ImageStore({ writer, bucket: "b" }) };
}

describe("runImageDrain — the state machine", () => {
  it("ready: url + provenance land on the row, the waiting forks are stamped, cost is summed", async () => {
    const big = await png();
    const store = new MemoryQueueStore([row("p1", { userId: null }), row("f1", { sourceStoreMealId: "p1" }), row("f2", { sourceStoreMealId: "p1" })]);
    const writer = new MemoryWriter();
    const ai = openaiStub(big, () => "ok");
    const summary = await runImageDrain({ store, pipeline: pipeline(ai.fetch, writer), now: () => new Date("2026-09-18T17:00:00Z") });
    assert.equal(summary.claimed, 1, "the two forks wait on their pending parent");
    assert.equal(summary.ready, 1);
    assert.equal(summary.forksStamped, 2);
    assert.equal(ai.calls(), 1, "one generation for the parent, none for the forks");
    assert.ok(summary.costEstimateUsd > 0);
    for (const id of ["p1", "f1", "f2"]) {
      const r = store.rows.get(id)!;
      assert.equal(r.imageStatus, "ready", id);
      assert.equal(r.imageUrl, "https://storage.googleapis.com/b/meals/p1.jpg", id);
    }
    assert.deepEqual(writer.saved, ["meals/p1.jpg"]);
  });

  it("an OpenAI error is a STRIKE: pending until the third attempt, then failed — and the pending forks fail with it", async () => {
    const big = await png();
    const store = new MemoryQueueStore([row("m1"), row("f1", { sourceStoreMealId: "m1" })]);
    const writer = new MemoryWriter();
    const ai = openaiStub(big, () => "http500");
    const deps = { store, pipeline: pipeline(ai.fetch, writer) };
    const s1 = await runImageDrain(deps);
    assert.deepEqual([s1.retried, s1.failed, s1.deferred], [1, 0, 0]);
    assert.equal(store.rows.get("m1")!.imageStatus, "pending");
    assert.equal(store.rows.get("m1")!.imageAttempts, 1);
    const s2 = await runImageDrain(deps);
    assert.deepEqual([s2.retried, s2.failed], [1, 0]);
    const s3 = await runImageDrain(deps);
    assert.deepEqual([s3.retried, s3.failed], [0, 1]);
    assert.equal(store.rows.get("m1")!.imageStatus, "failed");
    assert.equal(store.rows.get("m1")!.imageAttempts, IMAGE_MAX_ATTEMPTS);
    assert.equal(store.rows.get("f1")!.imageStatus, "failed", "the fork inherits the terminal state");
    const s4 = await runImageDrain(deps);
    assert.equal(s4.claimed, 0, "a failed row is never claimed again — no unbounded retry");
    assert.equal(ai.calls(), 3);
    assert.equal(writer.saved.length, 0);
  });

  it("a missing API key is a DEFERRAL: pending, attempt undone, no strike, no OpenAI call", async () => {
    const big = await png();
    const store = new MemoryQueueStore([row("m1")]);
    const writer = new MemoryWriter();
    const ai = openaiStub(big, () => "ok");
    const deps = { store, pipeline: pipeline(ai.fetch, writer, "") };
    for (let i = 0; i < 5; i++) {
      const s = await runImageDrain(deps);
      assert.deepEqual([s.claimed, s.deferred, s.retried, s.failed], [1, 1, 0, 0], `tick ${i}`);
    }
    assert.equal(store.rows.get("m1")!.imageStatus, "pending", "five deferrals and still pending — deferrals never exhaust a row");
    assert.equal(store.rows.get("m1")!.imageAttempts, 0);
    assert.equal(ai.calls(), 0);
    assert.deepEqual(new Set(store.releases.map((r) => r.outcome)), new Set(["defer"]));
  });

  it("the bucket write throwing is a STRIKE (the generation was paid for; the row's attempt stands)", async () => {
    const big = await png();
    const store = new MemoryQueueStore([row("m1")]);
    const writer = new MemoryWriter();
    writer.failWith = new Error("gcs down");
    const ai = openaiStub(big, () => "ok");
    const s = await runImageDrain({ store, pipeline: pipeline(ai.fetch, writer) });
    assert.deepEqual([s.ready, s.retried, s.deferred], [0, 1, 0]);
    assert.equal(store.rows.get("m1")!.imageStatus, "pending");
    assert.equal(store.rows.get("m1")!.imageAttempts, 1);
    assert.deepEqual(store.releases, [{ id: "m1", outcome: "strike" }]);
  });

  it("a throw past the pipeline (loadSubjects/markReady) still releases the row — never left `generating`", async () => {
    const big = await png();
    const store = new MemoryQueueStore([row("m1")]);
    store.markReady = async () => {
      throw new Error("db hiccup");
    };
    const ai = openaiStub(big, () => "ok");
    const s = await runImageDrain({ store, pipeline: pipeline(ai.fetch, new MemoryWriter()) });
    assert.equal(s.retried, 1);
    assert.equal(store.rows.get("m1")!.imageStatus, "pending");
  });

  it("the batch runs in PARALLEL and is capped at the claim size; the ledger userId follows the row's owner", async () => {
    const big = await png();
    const rows = Array.from({ length: 8 }, (_, i) => row(`m${i}`, { userId: i % 2 ? "u-odd" : null }));
    const store = new MemoryQueueStore(rows);
    const ai = openaiStub(big, () => "ok");
    const s = await runImageDrain({ store, pipeline: pipeline(ai.fetch, new MemoryWriter()) });
    assert.equal(s.claimed, IMAGE_DRAIN_BATCH);
    assert.equal(s.ready, IMAGE_DRAIN_BATCH);
    assert.equal(ai.inFlight.peak, IMAGE_DRAIN_BATCH, "five generations in flight at once, not one after another");
    assert.equal([...store.rows.values()].filter((r) => r.imageStatus === "pending").length, 3);
  });

  it("an empty claim is a no-op: no subjects loaded, no fetch, zeroed summary", async () => {
    const store = new MemoryQueueStore([]);
    let loads = 0;
    store.loadSubjects = async (ids) => {
      loads++;
      return ids.map((id) => ({ mealId: id, title: id, dishTitles: [] }));
    };
    const s = await runImageDrain({ store, pipeline: pipeline(async () => { throw new Error("never"); }, new MemoryWriter()) });
    assert.equal(s.claimed, 0);
    assert.equal(loads, 0);
  });
});
