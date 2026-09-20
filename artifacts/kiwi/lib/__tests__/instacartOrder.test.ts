// Row 8 Block 2 — what the phone sends to POST /grocery-lists/:id/instacart-link.
//
// Three things are pinned, in order of risk:
//   1. packCount is a NUMBER OF PACKS, never the displayed total. The server
//      multiplies by the row's stored per-pack size; the on-screen total would
//      multiply twice. The deliberate break for this block changes renderedPack
//      to return the scaled total and must go red HERE.
//   2. R1 — unchecked rows; universal staples only when opted in — against a
//      60-row fixture shaped like the measured list: exactly 54 sent, and the
//      six left out are named.
//   3. The copy map, status by status, never a raw server string.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError, ApiNetworkError } from "@/lib/api/errors";
import { renderedPack } from "@/lib/format/grocery";
import {
  INSTACART_COMING_SOON_COPY,
  INSTACART_EXPECTATION_COPY,
  INSTACART_GENERIC_COPY,
  INSTACART_NO_ITEMS_COPY,
  INSTACART_RATE_LIMIT_COPY,
  INSTACART_UNREACHABLE_COPY,
  instacartErrorCopy,
  instacartItemForRow,
  instacartItemsForList,
  selectInstacartRows,
} from "@/lib/instacartOrder";
import type { GroceryListItem } from "@/lib/types";

function row(over: Partial<GroceryListItem> & { id: string }): GroceryListItem {
  return {
    name: over.id,
    quantity: "1",
    quantityAmount: "1",
    quantityUnit: "each",
    sectionKey: "produce",
    isUniversalStaple: false,
    stapleOptedIn: false,
    isRecurringItem: false,
    isAmbiguous: false,
    isOptional: false,
    isCompleted: false,
    ...over,
  };
}

// ── The measured list: 60 rows, all unchecked, 7 universal staples of which
//    ONE is opted in. 54 go; the six not-opted-in staples stay home. ─────────
const NOT_OPTED_STAPLES = ["kosher salt", "black pepper", "olive oil", "all-purpose flour", "sugar", "soy sauce"];
const MEASURED_LIST: GroceryListItem[] = [
  ...NOT_OPTED_STAPLES.map((name) =>
    row({ id: `staple-${name}`, name, isUniversalStaple: true, stapleOptedIn: false, purchaseUnit: "container", purchaseDisplay: "1 container (26 oz)" }),
  ),
  row({ id: "staple-butter", name: "butter", isUniversalStaple: true, stapleOptedIn: true, purchaseUnit: "lb", purchaseDisplay: "1 lb" }),
  ...Array.from({ length: 53 }, (_, i) =>
    row({ id: `r${String(i + 1).padStart(2, "0")}`, name: `item ${i + 1}` }),
  ),
];

describe("R1 — the selection", () => {
  it("the 60-row measured list sends exactly 54; the six left out are the not-opted-in universal staples", () => {
    assert.equal(MEASURED_LIST.length, 60);
    const sent = selectInstacartRows(MEASURED_LIST);
    assert.equal(sent.length, 54);
    const sentIds = new Set(sent.map((r) => r.id));
    const excluded = MEASURED_LIST.filter((r) => !sentIds.has(r.id)).map((r) => r.id);
    assert.deepEqual(
      excluded,
      NOT_OPTED_STAPLES.map((n) => `staple-${n}`),
    );
    // The one opted-in staple travels.
    assert.ok(sentIds.has("staple-butter"));
    // And the wire body is the same 54, one entry per row, ids preserved.
    const items = instacartItemsForList(MEASURED_LIST);
    assert.equal(items.length, 54);
    assert.deepEqual(items.map((i) => i.groceryListItemId), sent.map((r) => r.id));
  });

  it("a checked row stays home; a checked opted-in staple stays home too", () => {
    const items = [
      row({ id: "a" }),
      row({ id: "b", isCompleted: true }),
      row({ id: "c", isUniversalStaple: true, stapleOptedIn: true, isCompleted: true }),
      row({ id: "d", isUniversalStaple: true, stapleOptedIn: true }),
    ];
    assert.deepEqual(selectInstacartRows(items).map((r) => r.id), ["a", "d"]);
  });

  it("stapleOptedIn absent (demo fixture / optimistic row) reads as not opted in", () => {
    const it0 = row({ id: "s", isUniversalStaple: true });
    delete (it0 as { stapleOptedIn?: boolean }).stapleOptedIn;
    assert.deepEqual(selectInstacartRows([it0]), []);
  });
});

describe("packCount is a number of PACKS, never the displayed total", () => {
  it("need 2 can against a 1-can pack — the screen reads '2 cans (14.5 oz)', the wire says packCount 2 × the row's 1 can", () => {
    const r = row({
      id: "beans",
      name: "black beans",
      quantityAmount: "2",
      quantityUnit: "can",
      purchaseUnit: "can",
      purchaseQuantity: 1,
      purchaseDisplay: "1 can (14.5 oz)",
    });
    assert.deepEqual(instacartItemForRow(r), {
      groceryListItemId: "beans",
      packCount: 2,
      packUnit: "can",
      packSizeText: "(14.5 oz)",
    });
  });

  it("need 3 lb against a 1.5 lb pack — the screen reads '3 lb pack'; the wire says 2 PACKS, not 3", () => {
    const r = row({
      id: "turkey",
      quantityAmount: "3",
      quantityUnit: "lb",
      purchaseUnit: "lb",
      purchaseQuantity: 1.5,
      purchaseDisplay: "1.5 lb pack",
    });
    const wire = instacartItemForRow(r);
    assert.equal(wire.packCount, 2);
    assert.notEqual(wire.packCount, 3, "3 is the displayed TOTAL — the server would order 3 × 1.5 = 4.5 lb");
    assert.equal(wire.packUnit, "lb");
    assert.equal(wire.packSizeText, undefined);
  });

  it("need 20 oz against a '1 lb block' (measured pack, container unit) — 2 packs", () => {
    const r = row({
      id: "cotija",
      quantityAmount: "20",
      quantityUnit: "oz",
      purchaseUnit: "block",
      purchaseDisplay: "1 lb block",
    });
    assert.equal(instacartItemForRow(r).packCount, 2);
  });

  it("a need of exactly one pack does not ceil to two on float noise", () => {
    const r = row({ id: "rice", quantityAmount: String(0.1 + 0.2), quantityUnit: "lb", purchaseUnit: "lb", purchaseDisplay: "0.3 lb bag" });
    assert.equal(instacartItemForRow(r).packCount, 1);
  });
});

describe("purchaseQuantityOverride wins — through the server's rule 2, so packCount is OMITTED", () => {
  // The server's per-pack size for an overridden row is the override itself
  // (purchaseQuantityOverride ?? purchaseQuantity). packCount = override
  // would order override² ("3 containers" → 9). Its own fixture sends
  // override rows with no packCount; so do we.
  it("a quantity override sends the bare id — no packCount, no packUnit, no size", () => {
    const r = row({
      id: "cottage",
      quantityAmount: "2",
      quantityUnit: "cup",
      purchaseUnit: "container",
      purchaseQuantity: 1,
      purchaseDisplay: "1 container (16 oz)",
      purchaseQuantityOverride: 3,
    });
    assert.deepEqual(instacartItemForRow(r), { groceryListItemId: "cottage" });
    assert.equal(
      renderedPack(r.purchaseDisplay, r.quantityAmount, r.quantityUnit, r.purchaseUnit, false, { quantity: 3 }),
      null,
    );
  });

  it("a LABEL-only override keeps the derived count on screen, so it keeps the derived packs on the wire", () => {
    const r = row({
      id: "beans",
      quantityAmount: "2",
      quantityUnit: "can",
      purchaseUnit: "can",
      purchaseDisplay: "1 can (14.5 oz)",
      purchaseDisplayOverride: "cans, low sodium",
    });
    assert.equal(instacartItemForRow(r).packCount, 2);
  });
});

describe("no derivable pack → packCount omitted, never 1", () => {
  it("no stored pack (user-added row)", () => {
    const r = row({ id: "x", quantityAmount: "3", quantityUnit: "each" });
    assert.deepEqual(instacartItemForRow(r), { groceryListItemId: "x" });
  });

  it("a container pack the need cannot be related to (cups against '1 can' with no size)", () => {
    const r = row({ id: "broth", quantityAmount: "2", quantityUnit: "cup", purchaseUnit: "can", purchaseDisplay: "1 can" });
    assert.deepEqual(instacartItemForRow(r), { groceryListItemId: "broth" });
  });

  it("a pantry staple renders no pack (BUG-171), so it sends none even when opted in", () => {
    const r = row({ id: "butter", isUniversalStaple: true, stapleOptedIn: true, quantityAmount: "4", quantityUnit: "tbsp", purchaseUnit: "lb", purchaseDisplay: "1 lb" });
    assert.deepEqual(instacartItemForRow(r), { groceryListItemId: "butter" });
  });

  it("no need at all", () => {
    const r = row({ id: "y", quantityAmount: undefined, quantityUnit: undefined, purchaseUnit: "can", purchaseDisplay: "1 can (14.5 oz)" });
    assert.deepEqual(instacartItemForRow(r), { groceryListItemId: "y" });
  });

  it("a pack count past the server's 99 ceiling is dropped, not clamped", () => {
    const r = row({ id: "z", quantityAmount: "500", quantityUnit: "each", purchaseUnit: "each", purchaseDisplay: "1 egg" });
    assert.deepEqual(instacartItemForRow(r), { groceryListItemId: "z" });
  });
});

describe("packUnit is the row's pack unit as the server sees it", () => {
  it("purchaseUnitOverride, when present, is the token the server compares against", () => {
    const r = row({ id: "milk", quantityAmount: "2", quantityUnit: "bottle", purchaseUnit: "bottle", purchaseDisplay: "1 bottle (half gallon)", purchaseUnitOverride: "carton" });
    const wire = instacartItemForRow(r);
    assert.equal(wire.packCount, 2);
    assert.equal(wire.packUnit, "carton");
  });

  it("an empty pack unit is omitted (the server falls back to the row's)", () => {
    const r = row({ id: "q", quantityAmount: "2", quantityUnit: "can", purchaseUnit: "", purchaseDisplay: "1 can (14.5 oz)" });
    const wire = instacartItemForRow(r);
    assert.equal(wire.packUnit, undefined);
  });
});

describe("the copy map", () => {
  const api = (status: number, body: unknown) => new ApiError("x", { status, body });

  it("403 retailer_disabled and 503 retailer_not_configured → coming soon", () => {
    assert.equal(instacartErrorCopy(api(403, { error: "retailer_disabled" })), INSTACART_COMING_SOON_COPY);
    assert.equal(instacartErrorCopy(api(503, { error: "retailer_not_configured" })), INSTACART_COMING_SOON_COPY);
  });
  it("502 retailer_error and 504 retailer_timeout → unreachable", () => {
    assert.equal(instacartErrorCopy(api(502, { error: "retailer_error" })), INSTACART_UNREACHABLE_COPY);
    assert.equal(instacartErrorCopy(api(504, { error: "retailer_timeout" })), INSTACART_UNREACHABLE_COPY);
  });
  it("429 → a few seconds", () => {
    assert.equal(instacartErrorCopy(api(429, { error: "Too many requests, slow down." })), INSTACART_RATE_LIMIT_COPY);
  });
  it("400 no_items → check off first; any other 400 → generic", () => {
    assert.equal(instacartErrorCopy(api(400, { error: "no_items", skipped: [] })), INSTACART_NO_ITEMS_COPY);
    assert.equal(instacartErrorCopy(api(400, { error: "invalid_body" })), INSTACART_GENERIC_COPY);
  });
  it("404, a network failure, a plain Error → generic; never the server's string", () => {
    assert.equal(instacartErrorCopy(api(404, { error: "list_not_found" })), INSTACART_GENERIC_COPY);
    assert.equal(instacartErrorCopy(new ApiNetworkError("fetch failed")), INSTACART_GENERIC_COPY);
    assert.equal(instacartErrorCopy(new Error("boom")), INSTACART_GENERIC_COPY);
    for (const c of [INSTACART_COMING_SOON_COPY, INSTACART_UNREACHABLE_COPY, INSTACART_RATE_LIMIT_COPY, INSTACART_NO_ITEMS_COPY, INSTACART_GENERIC_COPY]) {
      assert.ok(!/retailer_|no_items|list_not_found/.test(c), c);
    }
  });
  it("copy compliance: no 'free delivery', no 'partner', no store/delivery positioning, no speed claim", () => {
    for (const c of [INSTACART_EXPECTATION_COPY, INSTACART_COMING_SOON_COPY, INSTACART_UNREACHABLE_COPY, INSTACART_RATE_LIMIT_COPY, INSTACART_NO_ITEMS_COPY]) {
      const l = c.toLowerCase();
      assert.ok(!l.includes("free delivery"), c);
      assert.ok(!l.includes("partner"), c);
      assert.ok(!/\b(minutes?|hours?|fast|same-day|today)\b/.test(l), c);
      assert.ok(!/instacart (store|delivers|delivery)/.test(l), c);
    }
  });
});
