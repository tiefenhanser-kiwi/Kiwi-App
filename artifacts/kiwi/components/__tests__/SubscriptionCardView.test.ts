// Resub C2 §2 / §3 — Profile's Subscription card, rendered from
// subscriptionCardFor's answer for each source × platform.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { SubscriptionCardView } from "../SubscriptionCardView";
import {
  subscriptionCardFor,
  type ManageAction,
  type SubscriptionPayload,
} from "../../lib/billing/subscriptionView";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

const NOW = new Date("2026-10-05T12:00:00.000Z");

function sub(over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "trialing",
    planCode: "free",
    trialEndsAt: "2026-10-17T11:00:00.000Z",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: false,
    hasBillingAccount: false,
    source: null,
    managementUrl: null,
    storeBillingAvailable: true,
    ...over,
  };
}

const ACTIVE = { status: "active" as const, planCode: "monthly", currentPeriodEnd: "2026-11-05T00:00:00.000Z" };

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => r.unmount());
  }
});

interface Spy {
  premium: number;
  subscribe: number;
  manage: ManageAction[];
}

async function render(platform: string, s: SubscriptionPayload): Promise<{ tree: Node; spy: Spy }> {
  const card = subscriptionCardFor(platform, s, NOW);
  assert.ok(card, `${platform}: a card`);
  const spy: Spy = { premium: 0, subscribe: 0, manage: [] };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(SubscriptionCardView, {
        card: card!,
        onOpenPremium: () => {
          spy.premium += 1;
        },
        onSubscribe: () => {
          spy.subscribe += 1;
        },
        onManage: (a) => spy.manage.push(a),
        linkError: null,
      }),
    );
  });
  active = r;
  return { tree: r.toJSON() as unknown as Node, spy };
}

function byId(node: Node | string | null, id: string): Node | null {
  if (node == null || typeof node === "string") return null;
  if (node.props?.testID === id) return node;
  for (const c of node.children ?? []) {
    const hit = byId(c, id);
    if (hit) return hit;
  }
  return null;
}

function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

test("🔴 §2 the Kiwi Premium row is visible DURING THE TRIAL on iOS, says the days left, and opens the sheet", async () => {
  const { tree, spy } = await render("ios", sub());
  const row = byId(tree, "settings-premium");
  assert.ok(row, "the row renders for a trialing account");
  assert.ok(textOf(row).includes("Kiwi Premium"));
  assert.equal(textOf(byId(tree, "settings-premium-line")), "12 days left in your free trial");
  await act(async () => (row!.props!.onPress as () => void)());
  assert.equal(spy.premium, 1);
  assert.equal(byId(tree, "settings-subscribe"), null, "no Stripe Subscribe button on native");
});

test("§2 …and on Android, with enforcement off and no Stripe on the deploy", async () => {
  const { tree } = await render("android", sub({ enforced: false, billingAvailable: false }));
  assert.ok(byId(tree, "settings-premium"));
});

test("🔴 §3 apple / google on native: a Manage button that opens the store page", async () => {
  const { tree, spy } = await render("ios", sub({ ...ACTIVE, source: "apple", managementUrl: null }));
  assert.equal(byId(tree, "settings-premium"), null, "a paying account has no Kiwi Premium row");
  const b = byId(tree, "settings-manage-store");
  assert.equal(b?.props?.accessibilityLabel, "Manage subscription");
  await act(async () => (b!.props!.onPress as () => void)());
  assert.deepEqual(spy.manage, [
    { kind: "store_link", url: "https://apps.apple.com/account/subscriptions", label: "Manage subscription" },
  ]);
});

test("🔴 §3 apple / google on the web: text, no button", async () => {
  const { tree } = await render("web", sub({ ...ACTIVE, source: "google" }));
  assert.equal(textOf(byId(tree, "settings-manage-text")), "You're subscribed through Google Play — manage it there.");
  assert.equal(byId(tree, "settings-manage-store"), null);
  assert.equal(byId(tree, "settings-manage"), null);
});

test("🔴 §3 stripe on native: plain text, NO link of any kind", async () => {
  const { tree } = await render("ios", sub({ ...ACTIVE, source: "stripe", hasBillingAccount: true }));
  assert.equal(textOf(byId(tree, "settings-manage-text")), "You subscribed on the web. Manage or cancel at app.kitchenwizard.ai → Profile → Manage subscription.");
  assert.equal(byId(tree, "settings-manage"), null);
  assert.equal(byId(tree, "settings-manage-store"), null);
});

test("🔴 §3 stripe on the web: the existing Portal button", async () => {
  const { tree, spy } = await render("web", sub({ ...ACTIVE, source: "stripe", hasBillingAccount: true }));
  const b = byId(tree, "settings-manage");
  assert.ok(b);
  await act(async () => (b!.props!.onPress as () => void)());
  assert.deepEqual(spy.manage, [{ kind: "stripe_portal", label: "Manage subscription" }]);
});

test("§3 null source on the web: as today — the Subscribe button, no row", async () => {
  const { tree } = await render("web", sub());
  assert.ok(byId(tree, "settings-subscribe"));
  assert.equal(byId(tree, "settings-premium"), null);
});

// ── CLIENT-7 A (D-WS9-356) — free during launch ─────────────────────────────

async function renderFree(
  platform: string,
  s: SubscriptionPayload,
  extra: { restorePhase?: "idle" | "busy" | "stalled"; restoreMessage?: string | null } = {},
): Promise<{ tree: Node; calls: string[] }> {
  const card = subscriptionCardFor(platform, s, NOW, { storeReady: true });
  assert.ok(card);
  const calls: string[] = [];
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(SubscriptionCardView, {
        card: card!,
        onOpenPremium: () => calls.push("premium"),
        onSubscribe: () => calls.push("subscribe"),
        onManage: () => calls.push("manage"),
        linkError: null,
        onRestore: () => calls.push("restore"),
        onCheckAgain: () => calls.push("check-again"),
        ...extra,
      }),
    );
  });
  active = r;
  return { tree: r.toJSON() as unknown as Node, calls };
}

const FREE_SUB = { billing: { mode: "free_launch" } };

test("🔴 CLIENT-7 A: the free card says Kiwi is free and nothing else — no trial, price, Subscribe or Premium row", async () => {
  for (const platform of ["ios", "android", "web"]) {
    for (const status of ["trialing", "none", "canceled"] as const) {
      const { tree } = await renderFree(platform, sub({ status, ...FREE_SUB }));
      assert.equal(textOf(byId(tree, "settings-subscription-status")), "Kiwi is free during launch.");
      assert.equal(textOf(byId(tree, "settings-free-launch-body")), "Every feature is included. No card, nothing to cancel.");
      assert.equal(byId(tree, "settings-premium"), null);
      assert.equal(byId(tree, "settings-subscribe"), null);
      assert.equal(byId(tree, "settings-manage"), null);
      const all = textOf(tree);
      assert.equal(all.match(/trial|14|\$|subscribe|upgrade/i)?.[0] ?? null, null, `${platform} ${status}: ${all}`);
      assert.equal(byId(tree, "settings-restore") !== null, platform !== "web", `${platform}: Restore Purchases`);
      await act(async () => active!.unmount());
      active = null;
    }
  }
});

test("CLIENT-7 A: Restore Purchases restores; busy is disabled; a stalled restore offers Check again; the store's message shows", async () => {
  let { tree, calls } = await renderFree("ios", sub(FREE_SUB));
  const restore = byId(tree, "settings-restore");
  assert.equal(restore?.props?.accessibilityLabel, "Restore Purchases");
  await act(async () => (restore!.props!.onPress as () => void)());
  assert.deepEqual(calls, ["restore"]);
  await act(async () => active!.unmount());
  ({ tree } = await renderFree("ios", sub(FREE_SUB), { restorePhase: "busy" }));
  assert.equal(byId(tree, "settings-restore")?.props?.accessibilityLabel, "Restoring…");
  assert.equal(byId(tree, "settings-restore")?.props?.accessibilityState?.disabled, true);
  await act(async () => active!.unmount());
  ({ tree, calls } = await renderFree("ios", sub(FREE_SUB), { restorePhase: "stalled" }));
  await act(async () => (byId(tree, "settings-restore-check-again")!.props!.onPress as () => void)());
  assert.deepEqual(calls, ["check-again"]);
  assert.match(textOf(byId(tree, "settings-restore-message")), /hasn't confirmed it yet/);
  await act(async () => active!.unmount());
  ({ tree } = await renderFree("android", sub(FREE_SUB), { restoreMessage: "There's no Kiwi Premium purchase to restore on this account." }));
  assert.equal(textOf(byId(tree, "settings-restore-message")), "There's no Kiwi Premium purchase to restore on this account.");
});
