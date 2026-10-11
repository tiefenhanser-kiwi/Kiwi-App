// WEB-2 Part E (BUG-364 + BUG-389) — Kiwi's own Google button on native, and
// Google's web button re-drawn when its box changes width.
//
// Native: the button renders "Continue with Google" beside the unmodified "G",
// at AppleContinueButton's metrics, and a tap calls the handler the social
// block wires to signInWithGoogleNative → GoogleSignin.signIn(). The SDK has no
// node stub (and lib/oauth/native.ts is a lazy import in the block), so that
// chain is pinned at source level — the WEB-1 orderOnlineWiring precedent.
//
// Web: GIS draws into the host. The button used to keep the width of its first
// draw (BUG-389); now a width change re-draws it, after the layout settles.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { Radius } from "@/constants/tokens";
import { GOOGLE_CONTINUE_LABEL, GoogleContinueButton } from "../oauth/GoogleContinueButton";
import { GoogleWebButton, GSI_RERENDER_DEBOUNCE_MS } from "../oauth/GoogleWebButton";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
function walk(n: Json | string | null): Json[] {
  if (n == null || typeof n === "string") return [];
  return [n, ...(n.children ?? []).flatMap(walk)];
}
function text(n: Json | string | null): string {
  if (n == null) return "";
  if (typeof n === "string") return n;
  return (n.children ?? []).map(text).join("");
}
function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function" ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : style;
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean));
}

let mounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
});

function renderNative(props: { disabled?: boolean; busy?: boolean } = {}) {
  const presses: number[] = [];
  act(() => {
    mounted = TestRenderer.create(
      React.createElement(GoogleContinueButton, { onPress: () => presses.push(1), ...props }),
    );
  });
  const root = mounted!.toJSON() as Json;
  const button = walk(root).find((n) => n.props.testID === "google-continue")!;
  return { root, button, presses };
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

test("BUG-364 native: Kiwi's button reads 'Continue with Google' beside the G and a tap calls the handler", () => {
  const { root, button, presses } = renderNative();
  assert.ok(button, "the button renders on native");
  assert.equal(text(button), "Continue with Google");
  assert.equal(button.props.accessibilityLabel, GOOGLE_CONTINUE_LABEL);
  assert.equal(button.props.accessibilityRole, "button");
  const logo = walk(root).find((n) => n.props.testID === "google-g-logo");
  assert.ok(logo, "the G mark");
  assert.equal(walk(logo!).filter((n) => n.type === "rn-svg-path").length, 4, "the four-colour mark");
  act(() => (button.props.onPress as () => void)());
  assert.deepEqual(presses, [1]);
});

test("BUG-364 native: AppleContinueButton's metrics — 48 tall, full column width, Radius.md", () => {
  const { button } = renderNative();
  const st = flatten(button.props.style);
  assert.equal(st.height, 48);
  assert.equal(st.width, "100%");
  assert.equal(st.borderRadius, Radius.md);
  const apple = read("../oauth/AppleContinueButton.tsx");
  assert.match(apple, /const HEIGHT = 48;/);
  assert.match(apple, /cornerRadius=\{Radius\.md\}/);
});

test("BUG-364 native: held while busy or disabled", () => {
  assert.equal(renderNative({ busy: true }).button.props.disabled, true);
  act(() => mounted!.unmount());
  mounted = null;
  assert.equal(renderNative({ disabled: true }).button.props.disabled, true);
});

test("BUG-364 native: Google's SDK button is gone; the tap still reaches GoogleSignin.signIn()", () => {
  const btn = read("../oauth/GoogleContinueButton.tsx");
  assert.doesNotMatch(btn, /from "@react-native-google-signin\/google-signin"/, "no SDK import left");
  assert.doesNotMatch(btn, /<GoogleSigninButton/, "no SDK rendering left");
  const block = read("../oauth/SocialSignInBlock.tsx");
  assert.match(block, /<GoogleContinueButton onPress=\{onGoogle\}/);
  assert.match(
    block,
    /const onGoogle = React\.useCallback\(\s*\(\) =>\s*run\("google", async \(\) => \{\s*const \{ signInWithGoogleNative \} = await import\("@\/lib\/oauth\/native"\);/,
  );
  const native = read("../../lib/oauth/native.ts");
  assert.match(native, /const result = await GoogleSignin\.signIn\(\);/);
});

// ── web: GIS re-drawn on a width change (BUG-389) ─────────────────────────

test("BUG-389 web: a width change re-draws Google's button at the new width (after the layout settles)", async () => {
  const draws: { width: number }[] = [];
  let cleared = 0;
  const g = globalThis as Record<string, unknown>;
  const saved = { google: g.google, document: g.document, env: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID };
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "web-client";
  g.document = {
    getElementById: () => ({ dataset: { loaded: "1" }, addEventListener: () => {} }),
  };
  g.google = {
    accounts: {
      id: {
        initialize: () => {},
        renderButton: (_parent: unknown, opts: { width: number }) => draws.push({ width: opts.width }),
        disableAutoSelect: () => {},
      },
    },
  };
  try {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(GoogleWebButton, { onCredential: () => {}, onFailure: () => {} }),
        {
          createNodeMock: () => ({ replaceChildren: () => void cleared++ }),
        },
      );
    });
    mounted = r;
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    assert.deepEqual(draws, [{ width: 320 }], "the first draw, at the pre-layout width");

    const host = () => walk(r.toJSON() as Json).find((n) => n.props.testID === "google-continue-web")!;
    const layout = async (width: number) => {
      await act(async () => {
        (host().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width } } });
      });
    };
    await layout(288);
    assert.equal(draws.length, 1, "not on every layout tick");
    await act(async () => {
      await new Promise((res) => setTimeout(res, GSI_RERENDER_DEBOUNCE_MS + 30));
    });
    assert.deepEqual(draws.at(-1), { width: 288 }, "re-drawn at the new width");
    assert.equal(cleared, 1, "the old button is cleared first");

    // Two widths GIS clamps alike draw the same button: no re-draw.
    await layout(500);
    await act(async () => {
      await new Promise((res) => setTimeout(res, GSI_RERENDER_DEBOUNCE_MS + 30));
    });
    assert.deepEqual(draws.at(-1), { width: 400 });
    const count = draws.length;
    await layout(640);
    await act(async () => {
      await new Promise((res) => setTimeout(res, GSI_RERENDER_DEBOUNCE_MS + 30));
    });
    assert.equal(draws.length, count, "400 and 400: nothing to re-draw");
  } finally {
    g.google = saved.google;
    g.document = saved.document;
    if (saved.env === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = saved.env;
  }
});
