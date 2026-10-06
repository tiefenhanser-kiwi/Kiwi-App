// BUG-356 — the delete-account confirmation tells a store subscriber, before
// they confirm, that deleting the account does not stop the store subscription.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { StoreSubscriptionNotice } from "../StoreSubscriptionNotice";
import {
  deleteAccountNoticeFor,
  type ManageAction,
  type SubscriptionPayload,
} from "../../lib/billing/subscriptionView";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function sub(source: string, over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "active",
    planCode: "monthly",
    trialEndsAt: null,
    currentPeriodEnd: "2026-11-05T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    hasBillingAccount: source === "stripe",
    source,
    managementUrl: null,
    storeBillingAvailable: true,
    ...over,
  };
}

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => r.unmount());
  }
});

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

async function render(platform: string, s: SubscriptionPayload) {
  const notice = deleteAccountNoticeFor(platform, s);
  const managed: ManageAction[] = [];
  if (notice === null) return { tree: null as Node | null, managed, notice };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(StoreSubscriptionNotice, { notice, onManage: (a) => managed.push(a) }),
    );
  });
  active = r;
  return { tree: r.toJSON() as unknown as Node, managed, notice };
}

test("🔴 apple: the App Store sentence, and Manage subscription opens the store", async () => {
  const { tree, managed } = await render("ios", sub("apple"));
  assert.ok(tree);
  assert.ok(
    textOf(tree).includes(
      "Your Kiwi Premium subscription is billed by the App Store and keeps renewing until you cancel it there.",
    ),
  );
  const b = byId(tree, "delete-store-manage");
  assert.equal(b?.props?.accessibilityLabel, "Manage subscription");
  await act(async () => (b!.props!.onPress as () => void)());
  assert.equal(managed[0]?.kind, "store_link");
});

test("🔴 google: the Google Play sentence", async () => {
  const { tree } = await render("android", sub("google"));
  assert.ok(
    textOf(tree).includes(
      "Your Kiwi Premium subscription is billed by Google Play and keeps renewing until you cancel it there.",
    ),
  );
  assert.ok(byId(tree, "delete-store-manage"));
});

test("🔴 stripe: NO extra copy on any platform — DELETE /me cancels it", async () => {
  for (const os of ["ios", "android", "web"]) {
    const { tree, notice } = await render(os, sub("stripe"));
    assert.equal(notice, null, os);
    assert.equal(tree, null, os);
  }
});

test("the notice never blocks: it renders no control that stands in for the confirm", async () => {
  const { tree } = await render("ios", sub("apple"));
  // Its only pressable is Manage; the delete button and its gate are untouched.
  const pressables: Node[] = [];
  const walk = (n: Node | string | null) => {
    if (n == null || typeof n === "string") return;
    if (n.type === "rn-pressable") pressables.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  assert.deepEqual(pressables.map((p) => p.props?.testID), ["delete-store-manage"]);
});
