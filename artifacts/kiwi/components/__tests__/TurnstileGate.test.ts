// Resub C1 — TurnstileGate on a phone. The web gate injects a DOM script, which
// on native hung forever; the native gate runs the widget in a WebView and
// talks to it by postMessage. Driven here through the react-native-webview stub
// (lib/api/__tests__/stubs/react-native-webview.mjs), which renders an
// `rn-webview` host carrying every prop.

import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Platform } from "react-native";

import { TurnstileGate } from "../TurnstileGate";
import {
  TURNSTILE_NATIVE_BASE_URL,
  TURNSTILE_NATIVE_FAILED,
  TURNSTILE_NATIVE_TIMEOUT_MS,
} from "../../lib/guest/turnstile";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

const KEY = "EXPO_PUBLIC_TURNSTILE_SITE_KEY";
const realKey = process.env[KEY];
const platform = Platform as unknown as { OS: string };
const realOS = platform.OS;

before(() => {
  platform.OS = "ios";
});

after(() => {
  platform.OS = realOS;
  if (realKey === undefined) delete process.env[KEY];
  else process.env[KEY] = realKey;
});

let active: TestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
  mock.timers.reset();
  if (active) {
    const r = active;
    active = null;
    await act(async () => {
      r.unmount();
    });
  }
});

async function mount(onToken: (t: string) => void): Promise<TestRenderer.ReactTestRenderer> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(React.createElement(TurnstileGate, { onToken }));
  });
  active = r;
  return r;
}

function find(node: Node | string | null, pred: (n: Node) => boolean): Node | null {
  if (node == null || typeof node === "string") return null;
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

function webView(r: TestRenderer.ReactTestRenderer): Node | null {
  return find(r.toJSON() as unknown as Node, (n) => n.type === "rn-webview");
}

function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

async function post(r: TestRenderer.ReactTestRenderer, msg: unknown) {
  const wv = webView(r);
  assert.ok(wv, "the widget's WebView is mounted");
  await act(async () => {
    (wv!.props!.onMessage as (e: unknown) => void)({
      nativeEvent: { data: JSON.stringify(msg) },
    });
  });
}

test("🔴 a token message from the widget resolves the gate", async () => {
  process.env[KEY] = "0xNATIVEKEY";
  const tokens: string[] = [];
  const r = await mount((t) => tokens.push(t));
  await post(r, { type: "turnstile", token: "tok-123" });
  assert.deepEqual(tokens, ["tok-123"]);
  // Still the widget (now showing its success tick) — not the failure card.
  assert.ok(webView(r));
  assert.ok(!textOf(r.toJSON() as unknown as Node).includes(TURNSTILE_NATIVE_FAILED));
});

test("the WebView is configured to Cloudflare's mobile requirements", async () => {
  process.env[KEY] = "0xNATIVEKEY";
  const r = await mount(() => {});
  const p = webView(r)!.props!;
  const source = p.source as { html: string; baseUrl: string };
  assert.ok(source.html.includes("https://challenges.cloudflare.com/turnstile/v0/api.js"));
  assert.ok(source.html.includes('"0xNATIVEKEY"'));
  assert.equal(source.baseUrl, TURNSTILE_NATIVE_BASE_URL);
  assert.equal(p.javaScriptEnabled, true);
  assert.equal(p.domStorageEnabled, true);
  assert.equal(p.sharedCookiesEnabled, true);
  assert.equal(p.thirdPartyCookiesEnabled, true);
  assert.deepEqual(p.originWhitelist, ["*"]);
  // "Changing the User Agent during a session causes Turnstile challenges to fail."
  assert.equal("userAgent" in p, false);
  assert.equal("applicationNameForUserAgent" in p, false);
});

test("🔴 no token in 20 s shows the retry — never a hang — and retry brings the widget back", async () => {
  process.env[KEY] = "0xNATIVEKEY";
  mock.timers.enable({ apis: ["setTimeout"] });
  const tokens: string[] = [];
  const r = await mount((t) => tokens.push(t));

  await act(async () => {
    mock.timers.tick(TURNSTILE_NATIVE_TIMEOUT_MS - 1);
  });
  assert.ok(webView(r), "still waiting at 19.999 s");

  await act(async () => {
    mock.timers.tick(1);
  });
  const tree = r.toJSON() as unknown as Node;
  assert.equal(webView(r), null);
  assert.ok(textOf(tree).includes("We couldn't check this device. Try again."));
  const retry = find(tree, (n) => n.props?.testID === "turnstile-gate-retry");
  assert.ok(retry, "a retry button");

  await act(async () => {
    (retry!.props!.onPress as () => void)();
  });
  assert.ok(webView(r), "retry remounts the widget");
  await post(r, { type: "turnstile", token: "tok-after-retry" });
  assert.deepEqual(tokens, ["tok-after-retry"]);
});

test("a token at 19 s is not undone by the 20 s timer", async () => {
  process.env[KEY] = "0xNATIVEKEY";
  mock.timers.enable({ apis: ["setTimeout"] });
  const r = await mount(() => {});
  await act(async () => {
    mock.timers.tick(19_000);
  });
  await post(r, { type: "turnstile", token: "tok-late" });
  await act(async () => {
    mock.timers.tick(5_000);
  });
  assert.ok(webView(r), "still the solved widget");
});

test("the widget's own error shows the retry at once", async () => {
  process.env[KEY] = "0xNATIVEKEY";
  const r = await mount(() => {});
  await post(r, { type: "error" });
  assert.ok(textOf(r.toJSON() as unknown as Node).includes(TURNSTILE_NATIVE_FAILED));
});

test("🔴 site key unset → the gate skips: nothing renders, on native and on web", async () => {
  delete process.env[KEY];
  const r = await mount(() => {});
  assert.equal(r.toJSON(), null);
  await act(async () => {
    r.unmount();
  });
  active = null;
  platform.OS = "web";
  try {
    const w = await mount(() => {});
    assert.equal(w.toJSON(), null);
  } finally {
    platform.OS = "ios";
  }
});
