// Resub C5 (Part A) — the Test Kitchen entry opens the wizard only on a KNOWN
// session read.
//
// Hans's phone pass, October 7: a resumed guest session that had already made
// its plan (dev DB: generationCount 1, a draft, no `picks_submitted` row — the
// server's 409 fires before that write) reached "Build my week" through the
// "Meals to choose from" path, and the 409 opened the sign-up sheet the moment
// he tapped. The entry derived `spent` as `data ? … : false`, so while
// GET /guest/session was in flight (or after it failed) the form was a fresh
// visitor's form. These mount the real route with a stored session and a
// /guest/session answer the test controls.
//
// app/** is outside the test glob (D-WS9-164), so this lives beside the
// component tests and reaches into app/test-kitchen/ (TestKitchenNative's way).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as ExpoRouter from "expo-router";

import { GuestProvider } from "../../contexts/GuestContext";
import { clearGuestSession, storeGuestSession } from "../../lib/guest/guestToken";
import TestKitchenRoute from "../../app/test-kitchen/index";
import { GUEST_SPENT_TITLE } from "../WizardScreen";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}
const router = ExpoRouter as unknown as {
  __setRouterForTests(impl: Record<string, unknown>): void;
  __resetRouterForTests(): void;
};

const SESSION = {
  guestSessionId: "gs_gate",
  token: "guest-jwt",
  expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
};

/** Hans's row, as GET /guest/session returns it: the plan is made. */
const SPENT_READ = {
  id: SESSION.guestSessionId,
  expiresAt: SESSION.expiresAt,
  generationCount: 1,
  hasDraft: true,
  preferences: null,
  candidates: null,
};

const realFetch = globalThis.fetch;
let answerSession: ((r: Response) => void) | null = null;
let sessionReads = 0;
let sessionResponse: (() => Promise<Response>) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  storeGuestSession(SESSION);
  sessionReads = 0;
  answerSession = null;
  sessionResponse = null;
  router.__setRouterForTests({});
  globalThis.fetch = ((url: string) => {
    const u = String(url);
    if (u.endsWith("/guest/session")) {
      sessionReads += 1;
      if (sessionResponse) return sessionResponse();
      // Held until the test answers it.
      return new Promise<Response>((resolve) => {
        answerSession = resolve;
      });
    }
    if (u.endsWith("/guest/events")) return Promise.resolve(new Response(null, { status: 204 }));
    return new Promise(() => {});
  }) as typeof fetch;
});

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => {
      r.unmount();
    });
  }
  clearGuestSession();
  router.__resetRouterForTests();
  globalThis.fetch = realFetch;
});

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(GuestProvider, null, React.createElement(TestKitchenRoute)),
      ),
    );
  });
  active = r;
  return r;
}
async function settle() {
  await act(async () => {
    await new Promise((res) => setTimeout(res, 30));
  });
}

function all(node: Node | string | null, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) all(c, pred, out);
  return out;
}
function tree(r: TestRenderer.ReactTestRenderer): Node | null {
  const j = r.toJSON() as unknown;
  if (Array.isArray(j)) return { type: "root", children: j as Node[] };
  return j as Node | null;
}
function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  all(tree(r), (n) => n.props?.testID === id)[0];

test("C5 🔴 while GET /guest/session is in flight the wizard is NOT on screen — no CTA to tap", async () => {
  const r = await mount();
  await settle();
  assert.equal(sessionReads, 1, "the entry must read the session");
  assert.ok(byTestId(r, "tk-session-hold"), "the hold state did not render");
  assert.equal(byTestId(r, "wizard-build"), undefined, "the form rendered before the read landed");
});

test("C5 🔴 a spent session (generationCount 1, a draft) opens the form WITH the spent notice and the CTA disabled", async () => {
  const r = await mount();
  await settle();
  await act(async () => {
    answerSession!(json(SPENT_READ));
  });
  await settle();
  const cta = byTestId(r, "wizard-build");
  assert.ok(cta, `the form did not open; the screen says: ${textOf(tree(r))}`);
  assert.equal(cta!.props!.disabled, true, "a spent session's CTA must be disabled");
  assert.ok(textOf(tree(r)).includes(GUEST_SPENT_TITLE), "the spent notice is missing");
  assert.ok(byTestId(r, "guest-spent-sign-up"), "the notice's door is missing");
});

test("C5 a draft alone is spent — the server's gate is `generationCount >= 1 || draft`", async () => {
  sessionResponse = () => Promise.resolve(json({ ...SPENT_READ, generationCount: 0 }));
  const r = await mount();
  await settle();
  assert.equal(byTestId(r, "wizard-build")!.props!.disabled, true);
  assert.ok(textOf(tree(r)).includes(GUEST_SPENT_TITLE));
});

test("C5 a fresh session's read opens a live form, no notice", async () => {
  sessionResponse = () =>
    Promise.resolve(json({ ...SPENT_READ, generationCount: 0, hasDraft: false }));
  const r = await mount();
  await settle();
  const cta = byTestId(r, "wizard-build");
  assert.ok(cta, "the form did not open");
  assert.ok(!textOf(tree(r)).includes(GUEST_SPENT_TITLE));
});

test("C5 a failed read (500) is not a fresh session: the retry card, no form; Try again reads again", async () => {
  sessionResponse = () => Promise.resolve(json({ error: "failed to read session" }, 500));
  const r = await mount();
  await settle();
  assert.equal(byTestId(r, "wizard-build"), undefined, "a failed read must not open the form");
  const retry = byTestId(r, "tk-session-retry");
  assert.ok(retry, `no retry; the screen says: ${textOf(tree(r))}`);
  sessionResponse = () => Promise.resolve(json(SPENT_READ));
  await act(async () => {
    (retry!.props!.onPress as () => void)();
  });
  await settle();
  assert.equal(sessionReads, 2);
  assert.equal(byTestId(r, "wizard-build")!.props!.disabled, true);
});
