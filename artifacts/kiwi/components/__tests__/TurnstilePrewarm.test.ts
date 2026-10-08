// Resub C3 (BUG-361) — Turnstile pre-warmed on Welcome, spent at the Explore tap.
//
// Drives the hidden widget's page side through the react-native-webview stub
// (`props.onMessage({ nativeEvent: { data } })`) and then mounts the Test
// Kitchen entry under the SAME GuestProvider, the way the stack holds Welcome
// beneath it. What a device adds — Cloudflare actually solving inside an
// off-screen WebView — is not reachable here and is the phone pass's to check.

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Platform } from "react-native";

import { GuestProvider, useGuest } from "../../contexts/GuestContext";
import { clearGuestSession } from "../../lib/guest/guestToken";
import type { TurnstileWarmStore } from "../../lib/guest/turnstilePrewarm";
import { TurnstilePrewarm } from "../TurnstilePrewarm";
import TestKitchenRoute from "../../app/test-kitchen/index";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

const KEY = "EXPO_PUBLIC_TURNSTILE_SITE_KEY";
const platform = Platform as unknown as { OS: string };
const realOS = platform.OS;
const realFetch = globalThis.fetch;

/** Bodies POSTed to /guest/session, in order. */
let guestPosts: unknown[] = [];

before(() => {
  platform.OS = "ios";
  process.env[KEY] = "0xPREWARM";
});

after(() => {
  platform.OS = realOS;
  delete process.env[KEY];
  globalThis.fetch = realFetch;
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
  guestPosts = [];
});

// The store, read from inside the provider on every render.
let store: TurnstileWarmStore | null = null;
function Probe() {
  store = useGuest().turnstile;
  return null;
}

// Welcome's prewarm, then (on `explore`) the Test Kitchen entry on top of it.
let explore: () => void = () => {};
function Harness() {
  const [onTk, setOnTk] = React.useState(false);
  explore = () => setOnTk(true);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Probe),
    React.createElement(TurnstilePrewarm),
    onTk ? React.createElement(TestKitchenRoute) : null,
  );
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  // POST /guest/session answers 503: the start fails, which is the path that
  // must still spend the token.
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    if (String(url).endsWith("/guest/session") && init?.method === "POST") {
      guestPosts.push(JSON.parse(String(init.body)));
    }
    return new Response(JSON.stringify({ error: "down" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(GuestProvider, null, React.createElement(Harness)),
      ),
    );
  });
  active = r;
  return r;
}

function byTestId(r: TestRenderer.ReactTestRenderer, id: string) {
  return r.root.findAll((n) => n.props?.testID === id && typeof n.type === "string");
}

async function post(r: TestRenderer.ReactTestRenderer, msg: object) {
  const [webview] = byTestId(r, "turnstile-prewarm-webview");
  assert.ok(webview, "the hidden widget is mounted while warming");
  await act(async () => {
    (webview.props.onMessage as (e: unknown) => void)({
      nativeEvent: { data: JSON.stringify(msg) },
    });
  });
}

test("Welcome starts warming at once, off-screen and untouchable", async () => {
  const r = await mount();
  assert.equal(store?.status, "warming");
  const [frame] = byTestId(r, "turnstile-prewarm");
  assert.equal(frame.props.pointerEvents, "none");
  assert.equal(frame.props.importantForAccessibility, "no-hide-descendants");
  const style = frame.props.style as Record<string, unknown>;
  assert.equal(style.left, -10_000);
  assert.notEqual(style.display, "none");
  assert.ok((style.width as number) > 0 && (style.height as number) > 0, "not zero-sized");
});

test("🔴 a pre-warmed token is sent at the tap — no gate drawn — and is spent", async () => {
  const r = await mount();
  await post(r, { type: "turnstile", token: "tok-prewarm" });
  assert.equal(store?.status, "ready");
  assert.equal(store?.token, "tok-prewarm");
  assert.equal(byTestId(r, "turnstile-prewarm-webview").length, 0, "the widget is gone once ready");

  await act(async () => {
    explore();
  });
  assert.deepEqual(guestPosts, [{ turnstileToken: "tok-prewarm" }]);
  assert.equal(byTestId(r, "turnstile-gate").length, 0, "no visible gate");
  // The 503 failed the start; the token is spent all the same.
  assert.equal(store?.token, null);
  assert.notEqual(store?.status, "ready");
});

test("interactive: the hidden widget stands down and the tap shows the visible gate", async () => {
  const r = await mount();
  await post(r, { type: "interactive" });
  assert.equal(store?.status, "interactive");
  assert.equal(byTestId(r, "turnstile-prewarm-webview").length, 0, "left alone, not solved unseen");

  await act(async () => {
    explore();
  });
  assert.deepEqual(guestPosts, [], "nothing is sent without a token");
  assert.equal(byTestId(r, "turnstile-gate").length, 1, "the visible gate, as before");
});

test("still warming at the tap: the visible gate, exactly as before", async () => {
  const r = await mount();
  await act(async () => {
    explore();
  });
  assert.deepEqual(guestPosts, []);
  assert.equal(byTestId(r, "turnstile-gate").length, 1);
});

// ── Resub C4 · BUG-368 — "Try again" never resends the spent token ─────────

test("C4 🔴 BUG-368 after a failed create, 'Try again' does not resend the token — it shows a fresh gate, whose new token is sent", async () => {
  const r = await mount();
  await post(r, { type: "turnstile", token: "tok-prewarm" });
  await act(async () => {
    explore();
  });
  assert.deepEqual(guestPosts, [{ turnstileToken: "tok-prewarm" }]);

  const [tryAgain] = byTestId(r, "tk-try-again");
  assert.ok(tryAgain, "the failure card's Try again");
  await act(async () => {
    (tryAgain.props.onPress as () => void)();
  });
  assert.deepEqual(guestPosts, [{ turnstileToken: "tok-prewarm" }], "the spent token went out again");
  assert.equal(byTestId(r, "turnstile-gate").length, 1, "a fresh visible gate");

  const [gateView] = byTestId(r, "turnstile-webview");
  assert.ok(gateView, "the gate's widget");
  await act(async () => {
    (gateView.props.onMessage as (e: unknown) => void)({
      nativeEvent: { data: JSON.stringify({ type: "turnstile", token: "tok-fresh" }) },
    });
  });
  assert.deepEqual(guestPosts, [{ turnstileToken: "tok-prewarm" }, { turnstileToken: "tok-fresh" }]);
});
