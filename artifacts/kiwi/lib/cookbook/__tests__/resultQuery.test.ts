// BOOK-1C2 (item 3) — the filter race, reproduced against a real QueryClient
// with the Cookbook's real options (lib/cookbook/resultQuery.ts).
//
// Hans: Mexican + ≤30 + hands-on → "1 meal"; hands-on back to Any → still
// "1 meal"; later 39. Here: the screen leaves filters A for B, B's response
// lands FIRST, A's lands after it. The screen must end on B, must never print
// A's number as final, and A's request must be aborted when the screen left it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";

import type { CookbookPage } from "@/lib/api/cookbook";
import {
  cookbookCountOptions,
  cookbookMealsOptions,
  cookbookResultView,
  type FetchCookbookPage,
} from "../resultQuery";

const facets = { cuisines: [], thanksgiving: 0 };
const page = (total: number): CookbookPage => ({ meals: [], total, nextCursor: null, facets });

/** A fetch whose responses the test releases by hand, in any order. */
function controlledFetch() {
  const pending = new Map<string, { resolve: (p: CookbookPage) => void; signal?: AbortSignal }>();
  const fetchPage: FetchCookbookPage = (qs, signal) =>
    new Promise<CookbookPage>((resolve) => {
      pending.set(qs, { resolve, signal });
    });
  return {
    fetchPage,
    release(qs: string, total: number) {
      const p = pending.get(qs);
      if (!p) throw new Error(`no request for ${qs}; have ${[...pending.keys()].join(" | ")}`);
      p.resolve(page(total));
    },
    signal: (qs: string) => pending.get(qs)?.signal,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const BASE = "cuisine=mexican&maxMinutes=30&limit=30";
const HANDS_ON = "cuisine=mexican&maxMinutes=30&maxActiveMinutes=15&limit=30";
const ANY = "cuisine=mexican&maxMinutes=30&difficulty=easy&limit=30";

describe("the result list: out-of-order responses", () => {
  test("B lands before A: the screen ends on B, and A's late answer never reaches it", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const f = controlledFetch();
    const observer = new InfiniteQueryObserver<CookbookPage>(qc, cookbookMealsOptions(BASE, f.fetchPage) as never);
    const seen: Array<{ total: number | null; updating: boolean }> = [];
    const unsub = observer.subscribe((r) => {
      seen.push(cookbookResultView({ total: r.data?.pages[0]?.total, isPlaceholderData: r.isPlaceholderData }));
    });

    // The starting filters settle at 39.
    await tick();
    f.release(BASE, 39);
    await tick();
    assert.deepEqual(seen.at(-1), { total: 39, updating: false });

    // A: hands-on ≤15 (its answer will be 1) …
    observer.setOptions(cookbookMealsOptions(HANDS_ON, f.fetchPage) as never);
    await tick();
    // … then B before A has answered.
    observer.setOptions(cookbookMealsOptions(ANY, f.fetchPage) as never);
    await tick();

    // While B is in flight the held 39 is UPDATING, never final.
    assert.deepEqual(seen.at(-1), { total: 39, updating: true });

    // B answers first, A after it.
    f.release(ANY, 12);
    await tick();
    f.release(HANDS_ON, 1);
    await tick();
    await tick();

    const last = seen.at(-1)!;
    assert.deepEqual(last, { total: 12, updating: false }, "the screen ends on B's own answer");
    assert.ok(
      !seen.some((v) => v.total === 1),
      `A's "1 meal" must never be on screen; saw ${JSON.stringify(seen)}`,
    );
    // Every frame that prints a number as final carries its own filters' one
    // (a null total is the first load: nothing printed).
    for (const v of seen) {
      if (!v.updating && v.total !== null) assert.ok(v.total === 39 || v.total === 12, JSON.stringify(v));
    }
    unsub();
    qc.clear();
  });

  test("leaving a filter set aborts its request", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const f = controlledFetch();
    const observer = new InfiniteQueryObserver<CookbookPage>(qc, cookbookMealsOptions(HANDS_ON, f.fetchPage) as never);
    const unsub = observer.subscribe(() => undefined);
    await tick();
    const signal = f.signal(HANDS_ON);
    assert.ok(signal, "the queryFn hands fetch React Query's signal");
    assert.equal(signal!.aborted, false);
    observer.setOptions(cookbookMealsOptions(ANY, f.fetchPage) as never);
    await tick();
    assert.equal(signal!.aborted, true, "the request for the filters just left is cancelled");
    unsub();
    qc.clear();
  });
});

describe("the sheet's Show N meals: out-of-order responses", () => {
  test("a late count for the old draft never replaces the new draft's, and the held one is updating", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const f = controlledFetch();
    const A = "cuisine=mexican&maxMinutes=30&maxActiveMinutes=15&limit=1";
    const B = "cuisine=mexican&maxMinutes=30&limit=1";
    const observer = new QueryObserver<CookbookPage, Error, number>(qc, cookbookCountOptions(A, f.fetchPage) as never);
    const seen: Array<{ total: number | null; updating: boolean }> = [];
    const unsub = observer.subscribe((r) => {
      seen.push(cookbookResultView({ total: r.data, isPlaceholderData: r.isPlaceholderData }));
    });
    await tick();
    f.release(A, 1);
    await tick();
    assert.deepEqual(seen.at(-1), { total: 1, updating: false });

    observer.setOptions(cookbookCountOptions(B, f.fetchPage) as never);
    await tick();
    // Hans's exact frame: "1 meal" still showing after hands-on → Any. It may
    // show, but only as updating.
    assert.deepEqual(seen.at(-1), { total: 1, updating: true });

    f.release(B, 39);
    await tick();
    assert.deepEqual(seen.at(-1), { total: 39, updating: false });
    unsub();
    qc.clear();
  });
});

describe("cookbookResultView", () => {
  test("held data is updating; nothing loaded is a null total", () => {
    assert.deepEqual(cookbookResultView({ total: 5, isPlaceholderData: true }), { total: 5, updating: true });
    assert.deepEqual(cookbookResultView({ total: 5, isPlaceholderData: false }), { total: 5, updating: false });
    assert.deepEqual(cookbookResultView({ total: undefined, isPlaceholderData: false }), { total: null, updating: false });
  });

  test("the list's key carries the filters (equal filters share an entry, different ones never do)", () => {
    const fetchPage: FetchCookbookPage = async () => page(0);
    assert.notDeepEqual(cookbookMealsOptions(HANDS_ON, fetchPage).queryKey, cookbookMealsOptions(ANY, fetchPage).queryKey);
    assert.deepEqual(cookbookMealsOptions(ANY, fetchPage).queryKey, ["cookbook", "meals", ANY]);
  });
});
