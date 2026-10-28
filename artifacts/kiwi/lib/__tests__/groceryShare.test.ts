// CLIENT-5 D (BUG-570) — "Send my list": the text, the mailto cut, and where it goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  GROCERY_SHARE_EMPTY,
  GROCERY_SHARE_FOOTER,
  MAILTO_BODY_MAX,
  MAILTO_CUT_LINE,
  groceryMailtoHref,
  groceryShareLine,
  groceryShareText,
  sendGroceryList,
} from "@/lib/groceryShare";
import type { GroceryListItem } from "@/lib/types";

const row = (over: Partial<GroceryListItem> & Pick<GroceryListItem, "name" | "sectionKey">): GroceryListItem => ({
  id: over.name,
  quantity: "",
  isUniversalStaple: false,
  isRecurringItem: false,
  isAmbiguous: false,
  isOptional: false,
  isCompleted: false,
  ...over,
});

const LEMON = row({ name: "lemon", sectionKey: "produce", quantityAmount: "3", quantityUnit: "each", purchaseUnit: "each", purchaseQuantity: 3, purchaseDisplay: "3" });
const MILK = row({ name: "whole milk", sectionKey: "dairy_eggs", quantityAmount: "1.5", quantityUnit: "cup", purchaseUnit: "half gallon", purchaseQuantity: 1, purchaseDisplay: "1 half gallon" });
const TOWELS = row({ name: "paper towels", sectionKey: "household" });
const SALT_IN = row({ name: "Kosher salt", sectionKey: "pantry", isUniversalStaple: true, stapleOptedIn: true, quantityAmount: "2", quantityUnit: "teaspoon" });
const PEPPER_DEFAULT = row({ name: "black pepper", sectionKey: "pantry", isUniversalStaple: true, quantityAmount: "1", quantityUnit: "teaspoon" });
const EGGS = row({
  name: "eggs",
  sectionKey: "dairy_eggs",
  isRecurringItem: true,
  quantityAmount: "12",
  quantityUnit: "each",
  recurringFacets: { recurringQuantity: 12, recurringUnit: "each", mealQuantity: null, mealUnit: null, comparable: false },
});
const ONION_DONE = row({ name: "yellow onion", sectionKey: "produce", isCompleted: true, quantityAmount: "2", quantityUnit: "each" });

test("CLIENT-5 D: title, aisles in the screen's order with their unchecked rows, then the footer", () => {
  // Items arrive out of aisle order; the text is sorted by aisle as the screen is.
  const text = groceryShareText({ planName: "Week of Nov 2", items: [TOWELS, MILK, LEMON, ONION_DONE, SALT_IN, EGGS, PEPPER_DEFAULT] });
  assert.equal(
    text,
    [
      "Kiwi grocery list · Week of Nov 2",
      "",
      "Produce",
      "3 lemons (3 each)",
      "",
      "Dairy & Eggs",
      "1 half gallon whole milk (1½ cup)",
      "12 eggs — recurring",
      "",
      "Pantry",
      "Kosher salt (2 teaspoon)",
      "",
      "Household",
      "paper towels",
      "",
      "Made with Kiwi · kitchenwizard.ai",
    ].join("\n"),
  );
});

test("CLIENT-5 D: checked rows are out, and a default pantry staple (not opted in) is out", () => {
  const text = groceryShareText({ planName: "P", items: [LEMON, ONION_DONE, PEPPER_DEFAULT] });
  assert.ok(!text.includes("onion"), text);
  assert.ok(!text.includes("pepper"), text);
  // An aisle whose rows are all checked has no header.
  assert.ok(!groceryShareText({ planName: "P", items: [ONION_DONE, TOWELS] }).includes("Produce"));
});

test("CLIENT-5 D: each row is worded as the screen words it (a user rename is the name)", () => {
  assert.equal(groceryShareLine(MILK), "1 half gallon whole milk (1½ cup)");
  assert.equal(groceryShareLine({ ...TOWELS, userResolvedTo: "Bounty towels" }), "Bounty towels");
  assert.equal(groceryShareLine(EGGS), "12 eggs — recurring");
});

test("CLIENT-5 D: an empty list, or one with everything checked, says so", () => {
  const empty = groceryShareText({ planName: "Week of Nov 2", items: [] });
  assert.equal(empty, ["Kiwi grocery list · Week of Nov 2", GROCERY_SHARE_EMPTY, GROCERY_SHARE_FOOTER].join("\n\n"));
  assert.equal(groceryShareText({ planName: "Week of Nov 2", items: [ONION_DONE, PEPPER_DEFAULT] }), empty);
  assert.ok(groceryShareText({ planName: "  ", items: [] }).startsWith("Kiwi grocery list\n"));
});

test("CLIENT-5 D: mailto carries the whole text, URL-encoded, when it fits", () => {
  const text = groceryShareText({ planName: "Week & more", items: [LEMON, MILK] });
  const href = groceryMailtoHref(text, "Kiwi grocery list · Week & more");
  assert.ok(href.startsWith("mailto:?subject=Kiwi%20grocery%20list%20%C2%B7%20Week%20%26%20more&body="), href);
  const body = decodeURIComponent(href.split("&body=")[1]);
  assert.equal(body, text.replace(/\n/g, "\r\n"));
});

test("CLIENT-5 D: a very long list is cut at a whole line, says so, and keeps the footer", () => {
  const many = Array.from({ length: 200 }, (_, i) => row({ name: `item number ${i} with a longish name`, sectionKey: "pantry" }));
  const text = groceryShareText({ planName: "Big week", items: many });
  const href = groceryMailtoHref(text, "s");
  const encodedBody = href.split("&body=")[1];
  assert.ok(encodedBody.length <= MAILTO_BODY_MAX, String(encodedBody.length));
  const body = decodeURIComponent(encodedBody).split("\r\n");
  assert.equal(body[body.length - 1], GROCERY_SHARE_FOOTER);
  assert.equal(body[body.length - 3], MAILTO_CUT_LINE);
  // Every kept item line is a whole line of the original, in order.
  const kept = body.slice(0, -4);
  assert.deepEqual(kept, text.split("\n").slice(0, kept.length));
  assert.ok(kept.length > 10, String(kept.length));
});

test("CLIENT-5 D: native goes to Share.share({ message }); web to navigator.share, else the sheet", async () => {
  const calls: unknown[] = [];
  const nativeShare = async (c: unknown) => void calls.push(["native", c]);
  assert.equal(await sendGroceryList("T", "title", { os: "android", nativeShare }), "shared");
  assert.equal(await sendGroceryList("T", "title", { os: "ios", nativeShare }), "shared");
  assert.deepEqual(calls, [["native", { message: "T", title: "title" }], ["native", { message: "T", title: "title" }]]);
  calls.length = 0;
  const webShare = async (d: unknown) => void calls.push(["web", d]);
  assert.equal(await sendGroceryList("T", "title", { os: "web", nativeShare, webShare }), "shared");
  assert.deepEqual(calls, [["web", { title: "title", text: "T" }]]);
  assert.equal(await sendGroceryList("T", "title", { os: "web", nativeShare }), "sheet");
  const abort = Object.assign(new Error("x"), { name: "AbortError" });
  assert.equal(await sendGroceryList("T", "t", { os: "web", nativeShare, webShare: async () => Promise.reject(abort) }), "dismissed");
  const denied = Object.assign(new Error("x"), { name: "NotAllowedError" });
  assert.equal(await sendGroceryList("T", "t", { os: "web", nativeShare, webShare: async () => Promise.reject(denied) }), "sheet");
});

test("CLIENT-5 D: the copy never calls it \"one list\"", () => {
  const sources = ["../groceryShare.ts", "../../components/GroceryShareSheet.tsx"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));
  for (const src of sources) assert.ok(!/one list/i.test(src));
  assert.match(sources[1], /complete and sorted by aisle/);
});
