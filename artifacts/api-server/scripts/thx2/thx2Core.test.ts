// THX-2G — the pure rules of the Thanksgiving generation script. No database.
//
//   node --import tsx --test scripts/thx2/thx2Core.test.ts
//
// (scripts/** is outside the package's `pnpm test` glob, which covers src/
// only — run this file directly. The store-fill option tests, which guard the
// cached prefix, ARE in the suite: src/lib/__tests__/thx2StoreOptions.test.ts.)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as storeShortlist from "../../src/lib/store/storeShortlist";
import {
  ALTERNATE_TAG,
  COURSE_TAGS,
  FEAST_TAG,
  LEFTOVERS_TAG,
  LONG_WAIT_RULE,
  aheadTags,
  aheadTagsFor,
  dayPlanLines,
  thawStartDay,
  usesIngredient,
  SHELF_EXCLUSION_EXPORT,
  THANKSGIVING_TAG,
  approveRefusal,
  composeBrief,
  composeFinalizeBrief,
  dishTags,
  flagsFor,
  isRawTurkey,
  loadTargets,
  mentionWord,
  pathFlags,
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
  it("follow-up E: feasts carry thanksgiving-feast, Fridays thanksgiving-leftovers, pizza night neither — the seasons.ts strings", () => {
    for (const t of FILE.targets.filter((x) => x.kind !== "alternate")) {
      const want = t.kind === "feast" ? [THANKSGIVING_TAG, "thanksgiving-feast"] : t.kind === "friday" ? [THANKSGIVING_TAG, "thanksgiving-leftovers"] : [THANKSGIVING_TAG];
      assert.deepEqual(mealTags(t), want, t.key);
      assert.deepEqual(dishTags(t), [], `${t.key}: no every-dish tags`);
    }
    const seasons = readFileSync(new URL("../../src/lib/cookbook/seasons.ts", import.meta.url), "utf8");
    assert.ok(seasons.includes(`tag: "${FEAST_TAG}"`) && seasons.includes(`tag: "${LEFTOVERS_TAG}"`), "the Cookbook chips key on exactly these strings");
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
  it("EVERY target's finalize brief carries the long-wait rule; every feast with make-ahead dishes carries its days", () => {
    for (const t of FILE.targets) {
      const fb = composeFinalizeBrief(t);
      assert.ok(fb.startsWith(LONG_WAIT_RULE), t.key);
      assert.equal(runOptionsFor(t, FILE).finalizeBrief, fb);
      assert.equal(fb.includes("MAKE-AHEAD DAYS"), t.kind === "feast", t.key);
    }
    const ma = composeFinalizeBrief(byKey("thx2-feast-make-ahead"));
    assert.ok(ma.includes("This is a MAKE-AHEAD Thanksgiving") && ma.includes("Make ahead (Monday)") && ma.includes("Make ahead (Tuesday)"));
    const classic = composeFinalizeBrief(byKey("thx2-feast-classic"));
    assert.ok(classic.includes('opens with exactly "Make ahead (<Day>):"') && classic.includes('"On Thursday:"'));
    assert.ok(classic.includes("dishIndex 1 Pan Gravy: Make ahead (Tuesday) — simmer the stock from the neck and giblets"), "Classic's stock moves to Tuesday");
    assert.ok(!classic.includes("This is a MAKE-AHEAD Thanksgiving"));
    assert.ok(composeBrief(byKey("thx2-feast-classic")).includes("Make-ahead plan for this feast"), "the generate brief carries the days too");
  });
  it("follow-up E: make-ahead dish tags are written from targets.json, feast by feast", () => {
    const table = Object.fromEntries(FILE.targets.filter((t) => t.kind === "feast").map((t) => [t.key, Object.fromEntries(t.dishes.map((d) => [d.name, aheadTags(d).join(" ")]).filter(([, v]) => v))]));
    // THX-3 (BUG-425/450, D-WS9-316 decision 4): keep-days from the table (cooked 4,
    // gravy and broth 2, assembled 1), `assemble` on the dishes baked Thursday, the
    // overnight stuffing's Tuesday bread day, and Make-Ahead's gravy moved to Tuesday.
    assert.deepEqual(table, {
      "thx2-feast-classic": {
        "Herb-Roasted Whole Turkey": "thaw-6d brine-wed", "Pan Gravy": "ahead-tue keeps-2d", "Sage and Onion Stuffing": "ahead-wed keeps-1d assemble",
        "Cranberry-Orange Sauce": "ahead-mon keeps-4d", "Green Bean Casserole": "ahead-wed keeps-1d assemble", "Sweet Potato Casserole": "ahead-wed keeps-1d assemble", "Pumpkin Pie": "ahead-wed keeps-4d",
      },
      "thx2-feast-small": { "Roast Turkey Breast": "thaw-2d", "Small-Batch Sage Stuffing": "ahead-wed keeps-1d assemble", "Cranberry-Orange Sauce": "ahead-mon keeps-4d" },
      "thx2-feast-make-ahead": {
        "Dry-Brined Roast Turkey": "thaw-6d brine-tue", "Make-Ahead Turkey Gravy": "ahead-tue keeps-2d", "Overnight Sage Stuffing": "ahead-tue ahead-wed keeps-1d assemble",
        "Mashed Potato Casserole": "ahead-wed keeps-1d assemble", "Cranberry-Orange Sauce": "ahead-mon keeps-4d", "Pumpkin Pie": "ahead-tue keeps-4d",
      },
      "thx2-feast-vegetarian": { "Herb Stuffing": "ahead-wed keeps-1d assemble", "Cranberry-Orange Sauce": "ahead-mon keeps-4d", "Baked Mac and Cheese": "ahead-wed keeps-1d assemble", "Apple Pie": "ahead-wed keeps-4d" },
      "thx2-feast-new-twist": {
        "Citrus-Herb Spatchcock Turkey": "thaw-6d brine-wed", "Pan Gravy": "ahead-tue keeps-2d", "Cornbread and Chorizo Stuffing": "ahead-wed keeps-1d assemble",
        "Cranberry-Jalapeño Relish": "ahead-mon keeps-4d", "Pumpkin Cheesecake Bars": "ahead-wed keeps-4d",
      },
    });
    for (const t of FILE.targets.filter((x) => x.kind !== "feast")) assert.ok(t.dishes.every((d) => aheadTags(d).length === 0), t.key);
  });
  it("follow-up E: per-dish tags follow the TITLE, not the position; the thaw line names the day to start", () => {
    const classic = byKey("thx2-feast-classic");
    const tagFor = aheadTagsFor(classic);
    assert.deepEqual(tagFor({ title: "Classic Pumpkin Pie with Whipped Cream" }, 1), ["ahead-wed", "keeps-4d"], "a reordered pie keeps its own tags");
    assert.deepEqual(tagFor({ title: "Turkey Pan Gravy" }, 7), ["ahead-tue", "keeps-2d"]);
    assert.deepEqual(tagFor({ title: "Something Unasked" }, 3), [], "position fallback only for an unused target dish (#3 mashed potatoes has none)");
    assert.deepEqual(runOptionsFor(byKey("thx2-feast-classic"), FILE).dishTagsFor !== undefined, true);
    assert.equal(runOptionsFor(byKey("thx2-friday-classic"), FILE).dishTagsFor, undefined);
    const lines = dayPlanLines(classic).join(" ");
    assert.ok(lines.includes("Thaw (start Friday): if it is bought frozen, move it to the fridge on Friday, 6 days before Thanksgiving"), "thaw-6d = Thursday − 6 = Friday");
    assert.ok(dayPlanLines(byKey("thx2-feast-make-ahead")).join(" ").includes("Make ahead (Tuesday night): dry-brine the turkey"));
    assert.ok(dayPlanLines(byKey("thx2-feast-vegetarian")).every((l) => !l.includes("thaw")));
  });
  it("follow-up F: for every bird, the day in the thaw text is Thursday − n (PREP-1's row)", () => {
    const WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let birds = 0;
    for (const t of FILE.targets) {
      for (const d of t.dishes.filter((x) => x.thaw !== undefined)) {
        birds++;
        const want = WEEK[(((4 - d.thaw!) % 7) + 7) % 7];
        assert.equal(thawStartDay(d.thaw!), want, t.key);
        const line = dayPlanLines(t).find((l) => l.startsWith(`dishIndex ${t.dishes.indexOf(d)} ${d.name}: Thaw`))!;
        assert.ok(line, `${t.key}: a thaw line`);
        assert.deepEqual([...line.matchAll(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i), [want], `${t.key}: the text names only ${want}`);
      }
    }
    assert.equal(birds, 4, "Classic, Small (breast), Make-Ahead, New Twist");
    assert.equal(thawStartDay(6), "Friday");
    assert.equal(thawStartDay(2), "Tuesday");
  });
  it("follow-up F: every feast bird's brine — a tag and a 'Make ahead (<Day> night):' line, or 'do not brine'", () => {
    const want: Record<string, string> = {
      "thx2-feast-classic": "Make ahead (Wednesday night): wet-brine the turkey in a brining bag, 12 to 24 hours",
      "thx2-feast-new-twist": "Make ahead (Wednesday night): dry-brine the spatchcocked turkey",
      "thx2-feast-make-ahead": "Make ahead (Tuesday night): dry-brine the turkey",
      "thx2-feast-small": "do not brine this bird",
    };
    for (const [key, text] of Object.entries(want)) assert.ok(dayPlanLines(byKey(key)).some((l) => l.includes(text)), key);
    assert.deepEqual(
      FILE.targets.filter((t) => t.kind === "feast").map((t) => [t.key, t.dishes.find((d) => d.role === "main")!.brine ?? null]),
      [["thx2-feast-classic", "wed"], ["thx2-feast-small", null], ["thx2-feast-make-ahead", "tue"], ["thx2-feast-vegetarian", null], ["thx2-feast-new-twist", "wed"]],
    );
    assert.ok(!dayPlanLines(byKey("thx2-feast-vegetarian")).some((l) => l.includes("brine")), "no bird, no brine line");
    assert.deepEqual(dayPlanLines(byKey("thx2-alt-buttermilk-turkey")), [], "the day plan is the feast's alone");
  });
  it("follow-up F: a negated mention is not a use ('do not add extra salt')", () => {
    assert.equal(usesIngredient("Add the vegetables; do not add extra salt.", "salt"), false);
    assert.equal(usesIngredient("Season with no salt, then add 1 teaspoon pepper.", "salt"), false);
    assert.equal(usesIngredient("Season with ½ teaspoon kosher salt.", "salt"), true);
    assert.equal(usesIngredient("Do not overmix. Season with salt.", "salt"), true, "a negation in an earlier sentence does not reach");
    const dish = {
      title: "Sage and Onion Stuffing",
      ingredients: [{ name: "Kosher salt" }],
      substitutions: [{ product: "seasoned stuffing mix", replaces: ["white bread"] }],
      steps: [
        { text: "Season the bread with 1 teaspoon salt.", pathKey: null, componentKey: null },
        { text: "Toss the mix with the vegetables; do not add extra salt.", pathKey: "bought", componentKey: "bread" },
      ],
    };
    assert.deepEqual(pathFlags([dish]), [], "the bought step's 'do not add extra salt' is no use");
  });
  it("follow-up E: validation refuses make-ahead fields off a feast, an authored keeps, thaw off the bird", () => {
    const a = clone(); a.targets.find((t) => t.kind === "friday")!.dishes[0].ahead = "tue";
    assert.ok(validateTargets(a).some((e) => e.includes("feast dishes only")));
    // THX-3 — keep-days are the table's: an authored value is refused.
    const b = clone(); (b.targets.find((t) => t.key === "thx2-feast-classic")!.dishes[4] as { keeps?: number }).keeps = 7;
    assert.ok(validateTargets(b).some((e) => e.includes("keep-days table")));
    const b2 = clone(); b2.targets.find((t) => t.key === "thx2-feast-classic")!.dishes[4].alsoAhead = ["wed"];
    assert.ok(validateTargets(b2).some((e) => e.includes("must come before")));
    const c = clone(); c.targets.find((t) => t.key === "thx2-feast-classic")!.dishes[4].thaw = 2;
    assert.ok(validateTargets(c).some((e) => e.includes("belong on the bird")));
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

describe("follow-up C — targets, briefs, flags", () => {
  it("A New Twist has a pan gravy second, 8 dishes", () => {
    const t = byKey("thx2-feast-new-twist");
    assert.equal(t.dishes.length, 8);
    assert.equal(t.dishes[1].name, "Pan Gravy");
    assert.equal(t.dishes[1].role, "sauce");
  });
  it("every feast has a gravy", () => {
    for (const t of FILE.targets.filter((x) => x.kind === "feast")) assert.ok(t.dishes.some((d) => /gravy/i.test(d.name)), t.key);
  });
  it("the vegetarian targets carry the vegetarian rule (rennet cheese, Worcestershire) in both briefs", () => {
    const veg = FILE.targets.filter((t) => t.vegetarian).map((t) => t.key).sort();
    assert.deepEqual(veg, ["thx2-feast-vegetarian", "thx2-friday-vegetarian", "thx2-wednesday-pizza-night"]);
    for (const k of veg) {
      assert.ok(composeBrief(byKey(k)).includes("vegetarian Parmesan-style cheese"), k);
      assert.ok(composeBrief(byKey(k)).includes("Gruyère"), `${k}: the cheese the dev re-pilots slipped in is named`);
      assert.ok(composeFinalizeBrief(byKey(k)).includes("Worcestershire"), k);
    }
    assert.ok(!composeBrief(byKey("thx2-feast-classic")).includes("VEGETARIAN"));
  });
  it("a Friday meal with no leftovers is told to use none (the wild-rice soup)", () => {
    const b = composeBrief(byKey("thx2-friday-vegetarian"));
    assert.ok(b.includes("uses NO leftovers") && b.includes("cooks its own wild rice"));
    assert.ok(!b.includes("built from Thursday's leftovers"));
    assert.ok(composeBrief(byKey("thx2-friday-small")).includes("built from Thursday's leftovers"));
  });
  it("every generate brief carries the vessel, swap, whole-produce and unit rules; every finalize brief the step rules", () => {
    for (const t of FILE.targets) {
      const g = composeBrief(t);
      assert.ok(g.includes("12–14 cups fills a 9×13") && g.includes("real retail product") && g.includes('"2 oranges"') && g.includes('unit "pinch"'), t.key);
      const f = composeFinalizeBrief(t);
      assert.ok(f.includes("under 300 characters") && f.includes("never rinse raw poultry, the neck or the giblets") && f.includes("Warm corn tortillas") && f.includes("add no extra salt"), t.key);
    }
  });
  it("follow-up D: brining bag + 1 gallon + salt per gallon, multi-pack buys, dessert cooling as a note", () => {
    for (const t of FILE.targets) {
      const g = composeBrief(t);
      assert.ok(g.includes("brining bag") && g.includes("about 1 gallon of liquid") && g.includes("½ cup kosher salt per gallon"), t.key);
      assert.ok(g.includes('unit "package (2-count)", name "refrigerated pie crust (contains wheat)"'), t.key);
      assert.ok(g.includes("doubled one-pie filling"), t.key);
      const f = composeFinalizeBrief(t);
      assert.ok(f.includes("A DESSERT's cooling or setting of 1 hour or more") && f.includes("Savoury rests stay timed"), t.key);
      assert.ok(f.includes("turned halfway through"), t.key);
      assert.ok(!f.includes("cooling a pie 2 hours) stay timed"), "the old exemption is gone");
    }
  });
  it("production fix: the generate brief says quantity is a plain number and never asks for glyph quantities", () => {
    // Follow-up C's "Quantities are cook's fractions (⅛, ¼ …)" made the model write
    // `"quantity": ½` — not JSON — and it fell back to `dishes` as a string
    // (production, Oct 15: 3 failed attempts; the sweet potato pie unwritten).
    for (const t of FILE.targets) {
      const g = composeBrief(t);
      assert.ok(g.includes("quantity is a plain number") && g.includes("never a fraction glyph"), t.key);
      assert.ok(!/Quantities are cook's fractions/.test(g), `${t.key}: the old wording is gone`);
    }
  });
  it("buys_turkey matches raw turkey only — not broth, stock, gravy or leftovers", () => {
    for (const n of ["whole turkey", "turkey breast", "bone-in turkey thighs", "ground turkey", "turkey wings", "turkey"]) assert.ok(isRawTurkey(n), n);
    for (const n of ["low-sodium chicken or turkey broth", "turkey stock", "turkey gravy", "cooked leftover turkey", "smoked turkey sausage"]) assert.ok(!isRawTurkey(n), n);
    const fri = byKey("thx2-friday-small");
    assert.ok(!flagsFor(fri, FILE, { dishTitles: ["Turkey and Wild Rice Soup"], ingredientNames: ["cooked leftover turkey", "low-sodium chicken or turkey broth"], stamp: [], substitutionProducts: [] }).some((f) => f.code === "buys_turkey"));
  });
  it("vegetarian_rennet_cheese: Gruyère or Parmesan on a vegetarian target is reported; a labelled one is not", () => {
    const veg = byKey("thx2-feast-vegetarian");
    const titles = veg.dishes.map((d) => d.name);
    const base = { dishTitles: titles, stamp: ["dairy", "wheat"], substitutionProducts: [] as string[] };
    const prods = ["all-butter puff pastry (contains wheat, milk)", "refrigerated pie crust (contains wheat)"];
    assert.ok(flagsFor(veg, FILE, { ...base, ingredientNames: [...prods, "gruyère cheese"] }).some((f) => f.code === "vegetarian_rennet_cheese"));
    assert.ok(!flagsFor(veg, FILE, { ...base, ingredientNames: [...prods, "vegetarian Parmesan-style cheese", "sharp cheddar cheese"] }).some((f) => f.code === "vegetarian_rennet_cheese"));
    assert.ok(!flagsFor(byKey("thx2-feast-new-twist"), FILE, { dishTitles: byKey("thx2-feast-new-twist").dishes.map((d) => d.name), stamp: [], substitutionProducts: [], ingredientNames: ["parmesan"] }).some((f) => f.code === "vegetarian_rennet_cheese"), "only vegetarian targets");
  });
  it("path_unused: an ingredient only the scratch path uses, not replaced by a swap, is reported", () => {
    const dish = {
      title: "Herb-Roasted Turkey",
      ingredients: [{ name: "unsalted butter" }, { name: "fresh sage" }, { name: "whole turkey" }, { name: "kosher salt" }],
      substitutions: [{ product: "herb turkey rub packet", replaces: ["kosher salt"] }],
      steps: [
        { text: "Mash the butter with the chopped sage and salt.", pathKey: "scratch", componentKey: "rub" },
        { text: "Rub the turkey with the packet seasoning.", pathKey: "bought", componentKey: "rub" },
        { text: "Roast the turkey 3 hours.", pathKey: null, componentKey: null },
      ],
    };
    const flags = pathFlags([dish]);
    assert.deepEqual(flags.map((f) => f.detail.match(/"([^"]+)"/)![1]).sort(), ["fresh sage", "unsalted butter"]);
    assert.equal(mentionWord("garlic cloves"), "garlic");
    assert.deepEqual(pathFlags([{ ...dish, steps: dish.steps.map((s) => ({ ...s, pathKey: null, componentKey: null })) }]), [], "a single-path dish has nothing to report");
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
  it("proceeds against TODAY's storeShortlist.ts: THX-2S exports the exclusion (7f75172)", () => {
    // The contract is met in the checkout. It still says nothing about the
    // DEPLOYED server — approve runs only after THX-2S's deploy is live.
    assert.equal(approveRefusal(storeShortlist as unknown as Record<string, unknown>), null);
  });
});
