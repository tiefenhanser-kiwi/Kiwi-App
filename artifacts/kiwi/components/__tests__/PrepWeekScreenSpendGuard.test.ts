// D-WS9-241 D — PrepWeekScreen's error state and the spend guard.
//
// POST /plans/:id/prep-week is refused by the server's spend guard (D-WS9-240)
// with 429 (per-user cap) or 503 (global ceiling / kill switch) and a body
// `{ error: <copy>, reason }`. The screen's error branch rendered one local
// line for every failure — which turned "you've reached today's limit" into
// "we couldn't build your prep plan", the one thing a refusal must not say.
//
// Ruling: where the body carries one of the three guard reasons, the server's
// copy is rendered VERBATIM, keyed on `reason`. A 429/503 WITHOUT a guard
// reason, and every other failure, keeps the local line.
//
// Mounts the real screen against a fetch stub that answers the generate POST
// with the case under test and settles the plan/completions reads (the
// loading gate waits on all three; the error branch reads only prepQuery).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  __setForTests as seedSecureItem,
  __resetForTests as resetSecureStore,
} from "expo-secure-store";

import { PrepWeekScreen } from "../PrepWeekScreen";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function gatherText(node: Node | string | null, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) gatherText(c, out);
  }
  return out;
}

const originalFetch = globalThis.fetch;
let prepWeekResponse: () => Response;

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string) => {
    if (String(url).endsWith("/plans/plan-1/prep-week")) {
      return Promise.resolve(prepWeekResponse());
    }
    // The plan + completions reads must SETTLE for the loading gate to lift
    // (it waits on all three); what they settle to does not reach the error
    // branch, which reads prepQuery.error alone.
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetSecureStore();
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mount, let the generate POST settle, return the rendered copy. */
async function settledText(): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(PrepWeekScreen, {
            planId: "plan-1",
            onExit: () => {},
            onSaveExit: () => {},
          }),
        ),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    return gatherText(renderer.toJSON() as unknown as Node)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    if (renderer!) {
      await act(async () => {
        renderer.unmount();
      });
    }
    client.clear();
  }
}

const LOCAL_COPY = "We couldn't build your prep plan. Pull back and try again.";
const SPEND_CAP_USER_COPY =
  "You've reached today's planning limit — Kiwi will be ready to plan again tomorrow.";
const AI_UNAVAILABLE_COPY =
  "Kiwi is taking a short break. Please try again in a little while.";

test("spend_cap_user (429): the server's copy renders VERBATIM, not the local line", async () => {
  prepWeekResponse = () =>
    jsonResponse({ error: SPEND_CAP_USER_COPY, reason: "spend_cap_user" }, 429);
  const copy = await settledText();
  assert.ok(copy.includes(SPEND_CAP_USER_COPY), `server copy expected: ${copy}`);
  assert.ok(!copy.includes(LOCAL_COPY), `local copy must not show: ${copy}`);
});

test("spend_cap_global (503): the server's copy renders VERBATIM", async () => {
  prepWeekResponse = () =>
    jsonResponse({ error: AI_UNAVAILABLE_COPY, reason: "spend_cap_global" }, 503);
  const copy = await settledText();
  assert.ok(copy.includes(AI_UNAVAILABLE_COPY), `server copy expected: ${copy}`);
  assert.ok(!copy.includes(LOCAL_COPY), `local copy must not show: ${copy}`);
});

test("ai_disabled (503): the server's copy renders VERBATIM", async () => {
  prepWeekResponse = () =>
    jsonResponse({ error: AI_UNAVAILABLE_COPY, reason: "ai_disabled" }, 503);
  const copy = await settledText();
  assert.ok(copy.includes(AI_UNAVAILABLE_COPY), `server copy expected: ${copy}`);
});

test("a 503 WITHOUT a guard reason keeps the local line (the ruling does not over-reach)", async () => {
  prepWeekResponse = () => jsonResponse({ error: "Service Unavailable" }, 503);
  const copy = await settledText();
  assert.ok(copy.includes(LOCAL_COPY), `local copy expected: ${copy}`);
  assert.ok(!copy.includes("Service Unavailable"), `non-guard body not echoed: ${copy}`);
});

test("a 502 keeps the local line — the guard's status is not what keys the copy", async () => {
  prepWeekResponse = () =>
    jsonResponse({ error: "Kiwi got distracted. Try again?", reason: "sdk_error" }, 502);
  const copy = await settledText();
  assert.ok(copy.includes(LOCAL_COPY), `local copy expected: ${copy}`);
});
