// WS9 Redesign Arc Block 2a Part C (D-WS9-237) — the MERGED Kitchen Wizard.
//
// Mounts the real screen with its three reads faked (preferences, playlist,
// last-batch) and pins the wiring that matters: the CTA is gated on a chosen
// path; text mode has the box and prefs mode does not; the mix hydrates from
// STORED prefs; zero playlist → the nudge; path A calls POST /wizard/shelf and
// path B calls today's build path — and the two are never confused.

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
import { __resetRouterForTests, __setRouterForTests } from "expo-router";

import {
  CTA_HINT_NO_PATH,
  CTA_HINT_PICK,
  CTA_HINT_PLANS,
  PATH_PICK_TITLE,
  PATH_PLANS_TITLE,
  TEXT_SECTION_TITLE,
  WizardScreen,
  type WizardScreenProps,
} from "../WizardScreen";
import { NUDGE_TITLE, PLAYLIST_DIAL_LABEL } from "../preference-pickers/MixDials";
import { Palette } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}
function allText(node: Json | string | null): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}
function byTestId(root: Json, id: string): Json | undefined {
  return walk(root).find((n) => n.props.testID === id);
}
function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  const parts = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...parts.filter(Boolean));
}
/** Every onPress-bearing node whose own descendant text is exactly `label`. */
function pressablesByExactText(root: Json, label: string): Json[] {
  return walk(root).filter(
    (n) => (n.props as { onPress?: unknown }).onPress && allText(n).join("") === label,
  );
}

// ── the fake server ────────────────────────────────────────────────────────

const PREFS = {
  spiceTolerance: "mild",
  budgetLevel: "economy",
  cookingSkill: "intermediate",
  stovetopType: "gas",
  defaultRetailer: null,
  cuisines: ["Italian"],
  allergiesAndAvoidances: ["Peanuts"],
  otherAllergies: [],
  cookingEquipment: [],
  recurringGroceryItems: [],
  eatingStyles: [],
  healthGoals: [],
  pickyAvoidances: [],
  householdSize: 3,
  kidsCount: 0,
  pickyEaterCount: 0,
  planLengthDefault: 4,
  wantsLeftovers: false,
  weeklyPacingDefault: "mixed",
  dietaryNotes: null,
  discoveryLevel: "mostly",
  playlistLevel: "some",
  saucePreference: "balanced",
  maxCookTimeMinutes: 45,
  maxCookTimeCoverage: "most",
};
const SHELF = {
  meals: [],
  totalEligible: 0,
  hasMore: false,
  unmatchedNames: [],
};
const TELL_KIWI_RESULT = {
  candidates: [],
  parsedIntent: { scenario: "unclear", explicitMeals: [], intentDescriptors: [] },
};

const originalFetch = globalThis.fetch;
let playlistCount = 3;
let calls: { path: string; method: string; body: unknown }[] = [];
let pushed: unknown[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  calls = [];
  pushed = [];
  playlistCount = 3;
  __setRouterForTests({ push: (href: unknown) => pushed.push(href) });
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: u.slice(u.indexOf("/api") + 4), method, body });
    if (u.endsWith("/me/preferences")) return Promise.resolve(jsonResponse({ preferences: PREFS }));
    if (u.endsWith("/me/playlist"))
      return Promise.resolve(jsonResponse({ playlist: [], count: playlistCount }));
    if (u.endsWith("/wizard/last-batch")) return Promise.resolve(jsonResponse({ batch: null }));
    if (u.endsWith("/wizard/shelf")) return Promise.resolve(jsonResponse(SHELF));
    if (u.endsWith("/wizard/build-from-text"))
      return Promise.resolve(jsonResponse(TELL_KIWI_RESULT));
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetSecureStore();
  __resetRouterForTests();
  globalThis.fetch = originalFetch;
});

let mounted: { renderer: TestRenderer.ReactTestRenderer; client: QueryClient } | null = null;

async function mount(props: WizardScreenProps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(WizardScreen, props),
      ),
    );
  });
  // Let the three reads settle and the hydrate effect run.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  mounted = { renderer, client };
  return {
    root: () => renderer.toJSON() as unknown as Json,
    text: () => allText(renderer.toJSON() as unknown as Json),
  };
}

afterEach(async () => {
  if (mounted) {
    const { renderer, client } = mounted;
    await act(async () => {
      renderer.unmount();
    });
    client.clear();
    mounted = null;
  }
});

async function tap(node: Json | undefined, what: string) {
  assert.ok(node, `${what} not found`);
  await act(async () => {
    (node!.props.onPress as () => void)();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

// ── the gate ───────────────────────────────────────────────────────────────

test("the CTA is DISABLED with no path chosen, ENABLED once one is", async () => {
  const m = await mount({ mode: "prefs" });
  const cta = byTestId(m.root(), "wizard-build");
  assert.ok(cta, "CTA not found");
  assert.equal(cta!.props.disabled, true, "CTA must be disabled until a path is chosen");
  assert.ok(m.text().includes(CTA_HINT_NO_PATH));

  await tap(byTestId(m.root(), "wizard-path-pick"), "path A row");
  // Button passes `disabled || loading` through — off reads as undefined.
  assert.ok(!byTestId(m.root(), "wizard-build")!.props.disabled, "CTA still disabled after choosing a path");
  assert.ok(m.text().includes(CTA_HINT_PICK));

  await tap(byTestId(m.root(), "wizard-path-plans"), "path B row");
  assert.ok(m.text().includes(CTA_HINT_PLANS));
});

test("a disabled CTA does nothing — no call, no navigation", async () => {
  const m = await mount({ mode: "prefs" });
  await tap(byTestId(m.root(), "wizard-build"), "CTA");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(pushed.length, 0);
});

// ── the modes ──────────────────────────────────────────────────────────────

test("TEXT mode renders the Tell Kiwi section; PREFS mode does not", async () => {
  const t = await mount({ mode: "text", initialText: "something cozy" });
  assert.ok(t.text().includes(TEXT_SECTION_TITLE));
  assert.equal(byTestId(t.root(), "wizard-text")!.props.value, "something cozy");
  await act(async () => {
    t.root();
  });
  // Unmount before the second mount so the two do not share a tree.
  await act(async () => {
    mounted!.renderer.unmount();
  });
  mounted!.client.clear();
  mounted = null;

  const p = await mount({ mode: "prefs" });
  assert.ok(!p.text().includes(TEXT_SECTION_TITLE));
  assert.equal(byTestId(p.root(), "wizard-text"), undefined);
  // Both modes carry the two path rows and the mix.
  assert.ok(p.text().includes(PATH_PICK_TITLE));
  assert.ok(p.text().includes(PATH_PLANS_TITLE));
  assert.ok(p.text().includes(PLAYLIST_DIAL_LABEL));
});

// ── the mix hydrates from STORED prefs ─────────────────────────────────────

test("the mix hydrates from stored prefs: discovery=mostly, playlist=some are the selected chips", async () => {
  const m = await mount({ mode: "prefs" });
  const root = m.root();
  // Chips: selected ones carry the sage fill (Palette.chip.selected.background).
  const selectedLabels = walk(root)
    .filter(
      (n) =>
        n.props.onPress &&
        flatten(n.props.style).backgroundColor === Palette.chip.selected.background,
    )
    .map((n) => allText(n).join(""));
  assert.ok(selectedLabels.includes("Mostly"), `discovery 'Mostly' not selected: ${selectedLabels}`);
  assert.ok(selectedLabels.includes("Some"), `playlist 'Some' not selected: ${selectedLabels}`);
});

test("All on one dial forces None on the other (mirror of the server rule)", async () => {
  const m = await mount({ mode: "prefs" });
  const [, discoveryAll] = pressablesByExactText(m.root(), "All");
  await tap(discoveryAll, "discovery All chip");
  // Path A → the shelf body carries the resolved pair.
  await tap(byTestId(m.root(), "wizard-path-pick"), "path A row");
  await tap(byTestId(m.root(), "wizard-build"), "CTA");
  const shelfCall = calls.find((c) => c.path === "/wizard/shelf");
  assert.ok(shelfCall, "shelf not called");
  const body = shelfCall!.body as Record<string, unknown>;
  assert.equal(body.discoveryLevel, "all");
  assert.equal(body.playlistLevel, "none");
});

// ── the playlist gate ──────────────────────────────────────────────────────

test("zero playlist meals → the nudge replaces the Playlist row; non-zero → chips", async () => {
  playlistCount = 0;
  const z = await mount({ mode: "prefs" });
  assert.ok(z.text().includes(NUDGE_TITLE), "nudge missing at count 0");
  assert.ok(!z.text().includes(PLAYLIST_DIAL_LABEL));
  await act(async () => {
    mounted!.renderer.unmount();
  });
  mounted!.client.clear();
  mounted = null;

  playlistCount = 5;
  const n = await mount({ mode: "prefs" });
  assert.ok(n.text().includes(PLAYLIST_DIAL_LABEL), "chips missing at count 5");
  assert.ok(!n.text().includes(NUDGE_TITLE));
});

// ── the two paths ──────────────────────────────────────────────────────────

test("path A ('Meals to choose from') POSTs /wizard/shelf with the per-run body and routes to /pick-meals", async () => {
  const m = await mount({ mode: "prefs" });
  await tap(byTestId(m.root(), "wizard-path-pick"), "path A row");
  await tap(byTestId(m.root(), "wizard-build"), "CTA");
  const shelfCall = calls.find((c) => c.path === "/wizard/shelf");
  assert.ok(shelfCall, "POST /wizard/shelf not called");
  assert.equal(shelfCall!.method, "POST");
  const body = shelfCall!.body as Record<string, unknown>;
  // Hydrated → the stored values ride the body (D-WS7-035 override-else-stored).
  assert.equal(body.planDurationDays, 4);
  assert.equal(body.householdSize, 3);
  assert.deepEqual(body.allergiesAndAvoidances, ["Peanuts"]);
  assert.equal(body.discoveryLevel, "mostly");
  assert.equal(body.playlistLevel, "some");
  assert.equal("text" in body, false, "prefs mode sends no text");
  assert.equal(calls.some((c) => c.path === "/wizard/build-from-text"), false);
  const href = pushed[0] as { pathname: string; params: Record<string, string> };
  assert.equal(href.pathname, "/pick-meals");
  assert.equal(href.params.mode, "prefs");
  assert.equal(href.params.capMinutes, "45");
});

test("path B ('Complete plans') in PREFS mode routes to today's /wizard-results with the input — no shelf call", async () => {
  const m = await mount({ mode: "prefs" });
  await tap(byTestId(m.root(), "wizard-path-plans"), "path B row");
  await tap(byTestId(m.root(), "wizard-build"), "CTA");
  assert.equal(calls.some((c) => c.path === "/wizard/shelf"), false, "path B must not hit the shelf");
  const href = pushed[0] as { pathname: string; params: Record<string, string> };
  assert.equal(href.pathname, "/wizard-results");
  const input = JSON.parse(href.params.input) as Record<string, unknown>;
  assert.equal(input.discoveryLevel, "mostly");
  assert.equal(input.playlistLevel, "some");
});

test("path B in TEXT mode calls today's /wizard/build-from-text with the text + dials", async () => {
  const m = await mount({ mode: "text", initialText: "tacos twice and something light" });
  await tap(byTestId(m.root(), "wizard-path-plans"), "path B row");
  await tap(byTestId(m.root(), "wizard-build"), "CTA");
  const call = calls.find((c) => c.path === "/wizard/build-from-text");
  assert.ok(call, "build-from-text not called");
  const body = call!.body as Record<string, unknown>;
  assert.equal(body.description, "tacos twice and something light");
  assert.equal(body.discoveryLevel, "mostly");
  assert.equal(calls.some((c) => c.path === "/wizard/shelf"), false);
});

test("path A in TEXT mode sends the text on the shelf body", async () => {
  const m = await mount({ mode: "text", initialText: "burgers and a big salad" });
  await tap(byTestId(m.root(), "wizard-path-pick"), "path A row");
  await tap(byTestId(m.root(), "wizard-build"), "CTA");
  const shelfCall = calls.find((c) => c.path === "/wizard/shelf");
  assert.ok(shelfCall);
  assert.equal((shelfCall!.body as Record<string, unknown>).text, "burgers and a big salad");
  const href = pushed[0] as { pathname: string; params: Record<string, string> };
  assert.equal(href.params.mode, "text");
});

// ── Block 2c Part B — the CTA is ANCHORED: outside the scroll view ──────────

test("the CTA renders OUTSIDE the scrollable content (pinned under the header), gate untouched", async () => {
  const m = await mount({ mode: "prefs" });
  // One walk — toJSON() builds fresh objects per call, so indexOf needs one tree.
  const all = walk(m.root());
  const scroller = all.find((n) => n.type === "rn-keyboard-aware-scrollview");
  assert.ok(scroller, "scroll view not found");
  // 🔴 THE BREAK THIS CATCHES: the CTA moving back inside the scroll view.
  assert.equal(
    walk(scroller!).some((n) => n.props.testID === "wizard-build"),
    false,
    "the CTA must not be a descendant of the scroll view",
  );
  assert.ok(byTestId(m.root(), "wizard-build"), "the CTA still renders");
  assert.ok(byTestId(m.root(), "wizard-cta-bar"), "the anchored bar renders");
  // The bar sits ABOVE the scroll view in document order.
  assert.ok(
    all.findIndex((n) => n.props.testID === "wizard-cta-bar") < all.indexOf(scroller!),
    "the bar precedes the scroll view",
  );
  // The path rows still live in the scroll content and the gate still holds.
  assert.ok(walk(scroller!).some((n) => n.props.testID === "wizard-path-pick"));
  assert.equal(byTestId(m.root(), "wizard-build")!.props.disabled, true);
});
