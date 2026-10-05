// Resub C2 — the purchase sheet's body on iOS and Android (Apple 3.1.1 / 3.1.2).

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  NativePurchasePanel,
  type NativePurchasePanelProps,
} from "../NativePurchasePanel";
import type { StoreOfferView, StorePackage } from "../../lib/billing/store";
import { PRIVACY_URL, TERMS_URL } from "../../lib/legal";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function pkg(id: string, priceString: string, period: string): StorePackage {
  return {
    identifier: id,
    packageType: id === "monthly" ? "MONTHLY" : "ANNUAL",
    product: { identifier: `kiwi_premium_${id}`, priceString, subscriptionPeriod: period },
  };
}

const OFFER: StoreOfferView = {
  monthly: { plan: "monthly", priceString: "$9.99", period: "month", pkg: pkg("monthly", "$9.99", "P1M") },
  annual: { plan: "annual", priceString: "$99.99", period: "year", pkg: pkg("annual", "$99.99", "P1Y") },
};

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => r.unmount());
  }
});

interface Spy {
  bought: string[];
  restored: number;
  checked: number;
  opened: string[];
}

async function render(over: Partial<NativePurchasePanelProps> = {}): Promise<{ tree: Node; spy: Spy }> {
  const spy: Spy = { bought: [], restored: 0, checked: 0, opened: [] };
  const props: NativePurchasePanelProps = {
    store: "apple",
    sheet: "trialing",
    offerStatus: "ready",
    offer: OFFER,
    phase: "idle",
    message: null,
    onBuy: (p) => spy.bought.push(p),
    onRestore: () => {
      spy.restored += 1;
    },
    onCheckAgain: () => {
      spy.checked += 1;
    },
    onOpenLegal: (u) => spy.opened.push(u),
    ...over,
  };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(React.createElement(NativePurchasePanel, props));
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

function press(node: Node | null): void {
  assert.ok(node, "pressable present");
  (node!.props!.onPress as () => void)();
}

// ── offerings ─────────────────────────────────────────────────────────────

test("🔴 the offering renders as two buttons: the store's price and its period", async () => {
  const { tree, spy } = await render();
  assert.equal(byId(tree, "store-buy-monthly")?.props?.accessibilityLabel, "$9.99 / month");
  assert.equal(byId(tree, "store-buy-annual")?.props?.accessibilityLabel, "$99.99 / year");
  await act(async () => press(byId(tree, "store-buy-annual")));
  assert.deepEqual(spy.bought, ["annual"]);
});

test("a localized price is shown as the store sent it", async () => {
  const euro: StoreOfferView = {
    monthly: { ...OFFER.monthly!, priceString: "9,99 €" },
    annual: null,
  };
  const { tree } = await render({ offer: euro });
  assert.equal(byId(tree, "store-buy-monthly")?.props?.accessibilityLabel, "9,99 € / month");
  assert.equal(byId(tree, "store-buy-annual"), null);
});

// ── 3.1.2 on the sheet ────────────────────────────────────────────────────

test("🔴 the 3.1.2 terms are on the sheet: what it includes, price per period, renewal — App Store", async () => {
  const { tree } = await render({ store: "apple" });
  const all = textOf(tree);
  assert.ok(all.includes("Kiwi Premium includes"));
  assert.ok(all.includes("Unlimited plans"));
  assert.equal(
    textOf(byId(tree, "store-terms")),
    "Kiwi Premium is a subscription: $9.99 per month or $99.99 per year. " +
      "Payment is charged to your Apple ID at confirmation. The subscription renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel any time in your App Store settings.",
  );
});

test("🔴 …and on Android the store named is Google Play", async () => {
  const { tree } = await render({ store: "google" });
  const terms = textOf(byId(tree, "store-terms"));
  assert.ok(terms.includes("Payment is charged to your Google Play account at confirmation."));
  assert.ok(terms.includes("Manage or cancel any time in your Google Play settings."));
  assert.ok(!terms.includes("Apple"));
});

test("🔴 both legal links are on the sheet and open the real pages", async () => {
  const { tree, spy } = await render();
  assert.equal(textOf(byId(tree, "store-link-terms")), "Terms of Use");
  assert.equal(textOf(byId(tree, "store-link-privacy")), "Privacy Policy");
  await act(async () => press(byId(tree, "store-link-terms")));
  await act(async () => press(byId(tree, "store-link-privacy")));
  assert.deepEqual(spy.opened, [TERMS_URL, PRIVACY_URL]);
  assert.equal(TERMS_URL, "https://kitchenwizard.ai/terms.html");
  assert.equal(PRIVACY_URL, "https://kitchenwizard.ai/privacy.html");
});

test("during the trial the sheet says billing starts today — no bonus, no first-charge date", async () => {
  const { tree } = await render({ sheet: "trialing" });
  assert.equal(textOf(byId(tree, "store-billing-today")), "Subscribe now and billing starts today.");
  assert.doesNotMatch(textOf(tree), /first charge|extra days|more days free/);
  const lapsed = await render({ sheet: "lapsed" });
  assert.equal(byId(lapsed.tree, "store-billing-today"), null);
});

// ── restore ───────────────────────────────────────────────────────────────

test("Restore Purchases is on the sheet and calls onRestore", async () => {
  const { tree, spy } = await render();
  assert.equal(byId(tree, "store-restore")?.props?.accessibilityLabel, "Restore Purchases");
  await act(async () => press(byId(tree, "store-restore")));
  assert.equal(spy.restored, 1);
});

// ── no buy button where money could go wrong ──────────────────────────────

test("🔴 unavailable billing shows the line and NO buy button (and no restore)", async () => {
  const { tree } = await render({ offerStatus: "unavailable", offer: null });
  assert.equal(
    textOf(byId(tree, "store-unavailable")),
    "Purchases aren't available right now. Please try again later.",
  );
  assert.equal(byId(tree, "store-buy-monthly"), null);
  assert.equal(byId(tree, "store-buy-annual"), null);
  assert.equal(byId(tree, "store-restore"), null);
});

test("🔴 while confirming with Kiwi: the line, and NO buy button — never a second purchase", async () => {
  const { tree } = await render({ phase: "confirming" });
  assert.equal(textOf(byId(tree, "store-confirming")), "Purchase received — confirming it with Kiwi…");
  assert.equal(byId(tree, "store-buy-monthly"), null);
  assert.equal(byId(tree, "store-buy-annual"), null);
});

test("stalled: 'Check again' re-syncs; still no buy button", async () => {
  const { tree, spy } = await render({ phase: "stalled" });
  assert.equal(byId(tree, "store-buy-monthly"), null);
  await act(async () => press(byId(tree, "store-check-again")));
  assert.equal(spy.checked, 1);
});

test("buttons are disabled while a purchase is in the store's hands", async () => {
  const { tree } = await render({ phase: "purchasing" });
  const b = byId(tree, "store-buy-monthly");
  assert.equal((b?.props?.accessibilityState as { disabled?: boolean })?.disabled, true);
});
