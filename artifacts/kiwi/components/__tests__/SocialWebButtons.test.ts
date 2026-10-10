// WEB-1 Part G (BUG-364, the web half) — Apple's and Google's web buttons the
// same size, stacked and centred in the email form's column.
//
// Both are drawn by the provider's own script, so what this pins is the BOX
// each is given: one height for both hosts (Google's fixed 40), and one
// centred, capped-width container (lib/oauth/webButtonSize.ts) that both hosts
// stretch to. SocialSignInBlock reads Platform.OS once at module load, so its
// web branch is pinned at source level; native is pinned as untouched.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { AppleWebButton } from "../oauth/AppleWebButton";
import { GoogleWebButton } from "../oauth/GoogleWebButton";
import { WEB_SOCIAL_BUTTON } from "@/lib/oauth/webButtonSize";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };

function hostStyle(el: React.ReactElement): Record<string, unknown> {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  const root = r.toJSON() as Json;
  const style = Object.assign({}, ...[root.props.style].flat(Infinity).filter(Boolean));
  act(() => r.unmount());
  return style;
}

test("the shared box sits inside BOTH providers' limits", () => {
  // Google: width 200–400, height 40 fixed. Apple: width 130–375, height 30–64.
  assert.ok(WEB_SOCIAL_BUTTON.maxWidth >= 200 && WEB_SOCIAL_BUTTON.maxWidth <= 375);
  assert.equal(WEB_SOCIAL_BUTTON.height, 40);
});

test("Apple's and Google's hosts are the SAME height — Google's 40", () => {
  const apple = hostStyle(
    React.createElement(AppleWebButton, { onResult: () => {}, onFailure: () => {} }),
  );
  const google = hostStyle(
    React.createElement(GoogleWebButton, { onCredential: () => {}, onFailure: () => {} }),
  );
  const appleH = apple.height ?? apple.minHeight;
  const googleH = google.height ?? google.minHeight;
  assert.equal(appleH, WEB_SOCIAL_BUTTON.height);
  assert.equal(googleH, WEB_SOCIAL_BUTTON.height);
});

const here = dirname(fileURLToPath(import.meta.url));
const block = readFileSync(resolve(here, "../oauth/SocialSignInBlock.tsx"), "utf8");

test("web: both buttons share one centred, capped-width box in the form column", () => {
  const web = block.match(
    /PLATFORM === "web" \? \(\s*<View style=\{s\.webButtons\} testID="social-web-buttons">([\s\S]*?)<\/View>\s*\) : \(/,
  );
  assert.ok(web, "the web branch wraps the provider buttons in s.webButtons");
  assert.match(web![1], /<AppleWebButton/);
  assert.match(web![1], /<GoogleWebButton/);
  assert.ok(web![1].indexOf("<AppleWebButton") < web![1].indexOf("<GoogleWebButton"), "Apple first, stacked");
  const style = block.match(/webButtons: \{([\s\S]*?)\},/);
  assert.ok(style);
  assert.match(style![1], /width: "100%"/);
  assert.match(style![1], /maxWidth: WEB_SOCIAL_BUTTON\.maxWidth/);
  assert.match(style![1], /alignSelf: "center"/);
});

test("native: the native buttons render outside the web box, unchanged", () => {
  const native = block.match(/\) : \(\s*<>([\s\S]*?)<\/>\s*\);/);
  assert.ok(native, "native branch present");
  assert.match(native![1], /<AppleContinueButton\s+mode=\{mode\}\s+onPress=\{onApple\}\s+disabled=\{held\}\s+busy=\{busy === "apple"\}\s*\/>/);
  assert.match(native![1], /<GoogleContinueButton onPress=\{onGoogle\} disabled=\{held\} busy=\{busy === "google"\} \/>/);
  assert.doesNotMatch(native![1], /webButtons/);
});
