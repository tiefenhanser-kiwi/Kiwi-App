// CLIENT-9 E (BUG-467) — All Your Plans. GET /plans against SERVER-13 B's contract
// (`?limit=20&cursor=` → { items, nextCursor }, `?q=` searched server side, `plans`
// still sent for the apps already out), and usePlanPages paging through it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { getPlans } from "../plans";
import { ApiSchemaError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { usePlanPages } from "@/hooks/usePlanPages";
import { flattenPlanPages } from "@/lib/plans/planPages";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const row = (n: number) => ({
  id: `plan-${n}`,
  name: `Plan ${n}`,
  description: null,
  image: null,
  tags: [],
  source: "instance",
  status: "draft",
  startDate: null,
  endDate: null,
  isActiveThisWeek: false,
});

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

let urls: string[];
let respond: (url: URL) => Response;

beforeEach(() => {
  urls = [];
  respond = () => mockJson({ items: [row(1)], plans: [row(1)], activeThisWeek: null, nextCursor: null });
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    urls.push(String(url));
    return respond(new URL(String(url)));
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

test("getPlans sends limit, cursor and q (trimmed) when given", async () => {
  await getPlans(["my_plans"], { limit: 20, cursor: "c-1", q: "  taco night " });
  const u = new URL(urls[0]);
  assert.equal(u.pathname.endsWith("/plans"), true);
  assert.equal(u.searchParams.get("filter"), "my_plans");
  assert.equal(u.searchParams.get("limit"), "20");
  assert.equal(u.searchParams.get("cursor"), "c-1");
  assert.equal(u.searchParams.get("q"), "taco night");
});

test("getPlans sends no q for a blank search", async () => {
  await getPlans(["my_plans"], { q: "   " });
  assert.equal(new URL(urls[0]).searchParams.has("q"), false);
});

test("getPlans reads `items`, else `plans` (a server before SERVER-13 B)", async () => {
  respond = () => mockJson({ items: [row(2)], plans: [row(9)], activeThisWeek: null, nextCursor: "n" });
  assert.deepEqual((await getPlans()).plans.map((p) => p.id), ["plan-2"]);
  respond = () => mockJson({ plans: [row(3)], activeThisWeek: null, nextCursor: null });
  assert.deepEqual((await getPlans()).plans.map((p) => p.id), ["plan-3"]);
});

test("getPlans rejects a body with neither `items` nor `plans`", async () => {
  respond = () => mockJson({ activeThisWeek: null, nextCursor: null });
  await assert.rejects(() => getPlans(), (err: unknown) => err instanceof ApiSchemaError);
});

/** Read what the Plans tab reads while rendering: React Query re-renders only for
 *  the fields a render has read (tracked props). */
function probe<T extends { data?: unknown; hasNextPage: boolean }>(q: T): T {
  void q.data;
  void q.hasNextPage;
  return q;
}

async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

/** A server holding `total` plans, newest first, paged like SERVER-13 B. */
function pagedServer(total: number, match: (n: number) => boolean = () => true) {
  return (url: URL) => {
    const q = url.searchParams.get("q");
    const all = Array.from({ length: total }, (_, i) => total - i).filter((n) => (q ? match(n) : true));
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? all.indexOf(Number(cursor.slice(1))) + 1 : 0;
    const page = all.slice(start, start + limit);
    const next = start + limit < all.length ? `c${page[page.length - 1]}` : null;
    return mockJson({ items: page.map(row), plans: page.map(row), activeThisWeek: null, nextCursor: next });
  };
}

test("usePlanPages pages through every plan: 157 plans, 8 pages of 20, plan 1 reached", async () => {
  respond = pagedServer(157);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: ReturnType<typeof usePlanPages> | null = null;
  function Probe(): null {
    latest = probe(usePlanPages(["my_plans"], ""));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Probe)));
  });
  await settle(qc);
  assert.equal(flattenPlanPages(latest!.data?.pages).length, 20);
  while (latest!.hasNextPage) {
    await act(async () => {
      await latest!.fetchNextPage();
    });
    await settle(qc);
  }
  const all = flattenPlanPages(latest!.data?.pages);
  assert.equal(all.length, 157);
  assert.equal(all[156].id, "plan-1");
  assert.equal(urls.length, 8);
  assert.ok(urls.every((u) => new URL(u).searchParams.get("limit") === "20"));
  assert.equal(new URL(urls[1]).searchParams.get("cursor"), "c138");
  renderer.unmount();
});

test("usePlanPages sends the search to the server and pages its results", async () => {
  respond = pagedServer(157, (n) => n % 5 === 0);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: ReturnType<typeof usePlanPages> | null = null;
  function Probe(): null {
    latest = probe(usePlanPages(["my_plans"], "five"));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Probe)));
  });
  await settle(qc);
  await act(async () => {
    await latest!.fetchNextPage();
  });
  await settle(qc);
  const all = flattenPlanPages(latest!.data?.pages);
  assert.equal(all.length, 31);
  assert.equal(latest!.hasNextPage, false);
  assert.ok(urls.every((u) => new URL(u).searchParams.get("q") === "five"));
  renderer.unmount();
});
