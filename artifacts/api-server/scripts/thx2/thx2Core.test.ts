// THX-2G — the pure rules of the Thanksgiving generation script. No database.
//
//   node --import tsx --test scripts/thx2/thx2Core.test.ts
//
// (scripts/** is outside the package's `pnpm test` glob, which covers src/
// only — run this file directly. The store-fill option tests, which guard the
// cached prefix, ARE in the suite: src/lib/__tests__/thx2StoreOptions.test.ts.)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as storeShortlist from "../../src/lib/store/storeShortlist";
import {
  ALTERNATE_TAG,
  COURSE_TAGS,
  LONG_WAIT_RULE,
  SHELF_EXCLUSION_EXPORT,
  THANKSGIVING_TAG,
  approveRefusal,
  composeBrief,
  composeFinalizeBrief,
  dishTags,
  flagsFor,
  loadTargets,
  mealTags,
  runOptionsFor,
  shortcutFor,
  titleMatches,
  validateTargets,
  type TargetsFile,
} from "./thx2Core";

const FILE = loadTargets();
const clone = (): TargetsFile => JSON.parse(JSON.stringify(FILE)) as TargetsFile;
const byKey = (k: string) => {
  const t = FILE.targets.find((x) => x.key === k);
  if (!t) throw new Error(`no target ${k}`);
  return t;
};

describe("targets.json", () => {
  it("validates clean", () => {
    assert.deepEqual(validateTargets(FILE), []);
  });
  it("carries the §1 list plus pizza night: 5 feasts, 16 alternates, 5 Friday meals, 1 Wednesday — 27", () => {
    const n = (k: string) => FILE.targets.filter((t) => t.kind === k).length;
    assert.deepEqual([n("feast"), n("alternate"), n("friday"), n("weeknight")], [5, 16, 5, 1]);
    assert.equal(FILE.targets.length, 27);
  });
  it("pizza night: one shortcut product named with its allergens, thanksgiving tag only, 4 servings", () => {
    const p = byKey("thx2-wednesday-pizza-night");
    assert.deepEqual(p.products, ["frozen cheese pizza (contains wheat, milk)"]);
    assert.deepEqual(FILE.products[p.products[0]], ["wheat", "dairy"]);
    assert.deepEqual(mealTags(p), ["thanksgiving"]);
    assert.equal(p.servings, 4);
    assert.ok(composeBrief(p).includes("nobody wants to cook"));
  });
  it("every key starts with thx2- and none repeats", () => {
    const keys = FILE.targets.map((t) => t.key);
    assert.ok(keys.every((k) => k.startsWith("thx2-")));
    assert.equal(new Set(keys).size, keys.length);
  });
  it("feasts are ≤ 8 dishes at 10 (Small at 4); alternates 1 dish at 10; Friday at 4", () => {
    for (const t of FILE.targets) {
      assert.ok(t.dishes.length <= 8, t.key);
      if (t.kind === "feast") assert.equal(t.servings, t.plan === "small" ? 4 : 10, t.key);
      if (t.kind === "alternate") { assert.equal(t.dishes.length, 1, t.key); assert.equal(t.servings, 10, t.key); }
      if (t.kind === "friday") assert.equal(t.servings, 4, t.key);
    }
  });
  it("rejects a 9-dish feast, a duplicate key and a missing servings", () => {
    const f = clone();
    f.targets[0].dishes.push({ name: "Dinner Rolls", role: "side", course: "course-sides" });
    assert.ok(validateTargets(f).some((e) => e.includes("9 dishes")));
    const g = clone();
    g.targets[1].key = g.targets[0].key;
    assert.ok(validateTargets(g).some((e) => e.includes("duplicate key")));
    const h = clone();
    delete (h.targets[2] as { servings?: number }).servings;
    assert.ok(validateTargets(h).some((e) => e.includes("servings")));
  });
  it("rejects maxDishes above 8, an unknown product and an output cap past the SDK's non-streaming ceiling", () => {
    const a = clone(); a.maxDishes = 9;
    assert.ok(validateTargets(a).some((e) => e.startsWith("maxDishes")));
    const b = clone(); b.targets[0].products = ["frozen dinner rolls"];
    assert.ok(validateTargets(b).some((e) => e.includes("not in the products table")));
    const c = clone(); c.maxOutputTokens = 32000;
    assert.ok(validateTargets(c).some((e) => e.startsWith("maxOutputTokens")));
  });
});

describe("per-target options", () => {
  it("alternates: thanksgiving + thanksgiving-alternate + ONE course tag, on the meal AND its dish", () => {
    for (const t of FILE.targets.filter((x) => x.kind === "alternate")) {
      const tags = mealTags(t);
      assert.equal(tags[0], THANKSGIVING_TAG);
      assert.equal(tags[1], ALTERNATE_TAG);
      assert.equal(tags.filter((x) => (COURSE_TAGS as readonly string[]).includes(x)).length, 1, t.key);
      assert.deepEqual(dishTags(t), tags);
    }
  });
  it("feasts, Friday and Wednesday: thanksgiving on the meal, no dish tags", () => {
    for (const t of FILE.targets.filter((x) => x.kind !== "alternate")) {
      assert.deepEqual(mealTags(t), [THANKSGIVING_TAG]);
      assert.deepEqual(dishTags(t), []);
    }
  });
  it("runOptionsFor: non-public, the dish range and cap from the file, single_dish only for alternates", () => {
    const feast = runOptionsFor(byKey("thx2-feast-classic"), FILE);
    assert.equal(feast.isPublic, false);
    assert.equal(feast.maxDishes, 8);
    assert.equal(feast.maxOutputTokens, FILE.maxOutputTokens);
    assert.equal(feast.completeness, "meal");
    assert.equal(feast.transactionTimeoutMs, 60_000);
    assert.equal(feast.storedDifficulty, "medium", "feasts are stored as medium (Hans)");
    for (const t of FILE.targets.filter((x) => x.kind !== "feast")) assert.ok(!("storedDifficulty" in runOptionsFor(t, FILE)), t.key);
    assert.equal(feast.profiles![0].servings, 10);
    assert.deepEqual(feast.dishes![0].dishes, byKey("thx2-feast-classic").dishes.map((d) => d.name));
    assert.equal(runOptionsFor(byKey("thx2-alt-buttermilk-turkey"), FILE).completeness, "single_dish");
    assert.equal(runOptionsFor(byKey("thx2-friday-classic"), FILE).profiles![0].servings, 4);
  });
  it("shortcut mode: store-bought products named with their allergens, then the leftovers", () => {
    assert.equal(shortcutFor(byKey("thx2-feast-classic")), "store-bought fried onions (contains wheat, soy); refrigerated pie crust (contains wheat)");
    assert.equal(shortcutFor(byKey("thx2-friday-small")), "cooked leftover turkey");
    assert.equal(shortcutFor(byKey("thx2-feast-small")), undefined);
  });
  it("EVERY target's finalize brief carries the long-wait rule; only Make-Ahead adds the days", () => {
    for (const t of FILE.targets) {
      assert.ok(composeFinalizeBrief(t).startsWith(LONG_WAIT_RULE), t.key);
      assert.equal(runOptionsFor(t, FILE).finalizeBrief, composeFinalizeBrief(t));
    }
    const fb = composeFinalizeBrief(byKey("thx2-feast-make-ahead"));
    assert.ok(fb.includes("we suggest Monday") && fb.includes("we suggest Tuesday") && fb.includes("dishIndex 0"));
    assert.equal(composeFinalizeBrief(byKey("thx2-feast-classic")), LONG_WAIT_RULE);
    assert.equal(composeFinalizeBrief(byKey("thx2-alt-buttermilk-turkey")), LONG_WAIT_RULE);
  });
  it("the alternate brief lifts the complete-dinner rule; the feast brief lists roles in order", () => {
    assert.ok(composeBrief(byKey("thx2-alt-pecan-pie")).includes("NOT a complete dinner"));
    assert.ok(composeBrief(byKey("thx2-feast-classic")).includes("1. Herb-Roasted Whole Turkey (role main); 2. Pan Gravy (role sauce)"));
  });
});

describe("flags", () => {
  const classic = byKey("thx2-feast-classic");
  const titles = classic.dishes.map((d) => d.name);
  it("puff pastry / fried onions whose usual allergens are missing from the stamp are flagged", () => {
    const flags = flagsFor(classic, FILE, { dishTitles: titles, ingredientNames: ["crispy fried onions", "refrigerated pie crust (contains wheat)"], stamp: ["wheat"], substitutionProducts: [] });
    assert.deepEqual(flags.map((f) => f.code).sort(), ["product_allergens_missing", "product_renamed"]);
    assert.ok(flags.find((f) => f.code === "product_allergens_missing")!.detail.includes("soy"));
  });
  it("a clean stamp, exact names and the asked order carry no flag", () => {
    const flags = flagsFor(classic, FILE, { dishTitles: titles, ingredientNames: ["store-bought fried onions (contains wheat, soy)", "refrigerated pie crust (contains wheat)"], stamp: ["dairy", "soy", "wheat"], substitutionProducts: [] });
    assert.deepEqual(flags, []);
  });
  it("a missing product, a product as a swap, a dropped dish and a Friday turkey purchase are flagged", () => {
    assert.ok(flagsFor(classic, FILE, { dishTitles: titles.slice(1), ingredientNames: [], stamp: [], substitutionProducts: ["refrigerated pie crust"] }).some((f) => f.code === "product_not_listed"));
    assert.ok(flagsFor(classic, FILE, { dishTitles: titles, ingredientNames: ["refrigerated pie crust (contains wheat)"], stamp: ["wheat"], substitutionProducts: ["refrigerated pie crust"] }).some((f) => f.code === "product_in_substitution"));
    assert.ok(flagsFor(classic, FILE, { dishTitles: titles.slice(1), ingredientNames: [], stamp: [], substitutionProducts: [] }).some((f) => f.code === "dish_count"));
    const fri = byKey("thx2-friday-small");
    assert.ok(flagsFor(fri, FILE, { dishTitles: ["Turkey and Wild Rice Soup"], ingredientNames: ["cooked leftover turkey", "boneless turkey breast"], stamp: [], substitutionProducts: [] }).some((f) => f.code === "buys_turkey"));
  });
  it("dish order: an embellished title matches, a swapped order does not", () => {
    assert.equal(titleMatches("Pan Gravy", "Classic Turkey Pan Gravy"), true);
    assert.equal(titleMatches("Sage and Onion Stuffing", "Sage & Onion Bread Stuffing"), true);
    assert.equal(titleMatches("Mashed Potatoes", "Cranberry-Orange Sauce"), false);
    const swapped = [...titles]; [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    const flags = flagsFor(classic, FILE, { dishTitles: swapped, ingredientNames: ["store-bought fried onions (contains wheat, soy)", "refrigerated pie crust (contains wheat)"], stamp: ["soy", "wheat"], substitutionProducts: [] });
    assert.deepEqual(flags.map((f) => f.code), ["dish_order"]);
  });
});

describe("approve's guard", () => {
  it("refuses without the shelf exclusion export, or with one that lacks thanksgiving", () => {
    assert.ok(approveRefusal({}));
    assert.ok(approveRefusal({ [SHELF_EXCLUSION_EXPORT]: ["holiday"] }));
    assert.ok(approveRefusal({ [SHELF_EXCLUSION_EXPORT]: "thanksgiving" }));
  });
  it("proceeds when the export contains thanksgiving (array or Set)", () => {
    assert.equal(approveRefusal({ [SHELF_EXCLUSION_EXPORT]: ["thanksgiving"] }), null);
    assert.equal(approveRefusal({ [SHELF_EXCLUSION_EXPORT]: new Set(["thanksgiving"]) }), null);
  });
  it("refuses against TODAY's storeShortlist.ts (THX-2S has not built the exclusion)", () => {
    // When THX-2S lands EVERYDAY_SHELF_EXCLUDED_TAGS, this test flips: update it then.
    assert.ok(approveRefusal(storeShortlist as unknown as Record<string, unknown>));
  });
});
