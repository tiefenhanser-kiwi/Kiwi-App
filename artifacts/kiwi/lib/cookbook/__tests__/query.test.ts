// BOOK-1C1 (D-WS9-312) — the Cookbook filter state → GET /cookbook/meals query,
// the quick chips, and the card's pure lines (the difficulty mapping included).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeFilterCount,
  buildCookbookQuery,
  cardMetaLine,
  cardPills,
  cuisineLabel,
  cuisineQuickChips,
  cuisineSheetTokens,
  CUISINE_CHIP_MIN,
  difficultyLabel,
  effectiveQuery,
  EMPTY_FILTERS,
  FIXED_QUICK_CHIPS,
  hasAnyFilter,
  isQuickOn,
  mealCountLabel,
  toggleQuick,
  type CookbookFilters,
} from "../query";

const f = (over: Partial<CookbookFilters> = {}): CookbookFilters => ({ ...EMPTY_FILTERS, ...over });
const parse = (qs: string) => Object.fromEntries(new URLSearchParams(qs));

describe("buildCookbookQuery — the filter → query mapping", () => {
  test("defaults send nothing: no filters, popular sort", () => {
    assert.equal(buildCookbookQuery({}), "");
    assert.equal(buildCookbookQuery({ filters: EMPTY_FILTERS, sort: "popular", q: "" }), "");
  });

  test("every filter maps to its server param", () => {
    const qs = buildCookbookQuery({
      q: "  turkey ",
      filters: f({
        cuisines: ["thai", "indian"],
        maxMinutes: 45,
        maxActiveMinutes: 20,
        difficulty: ["hard", "easy"],
        highProtein: true,
        under600: true,
      }),
      sort: "quickest",
      tag: "course-turkey",
      limit: 30,
      cursor: "abc",
    });
    assert.deepEqual(parse(qs), {
      q: "turkey",
      cuisine: "indian,thai",
      maxMinutes: "45",
      maxActiveMinutes: "20",
      // "hard" stays "hard" on the wire: the server maps it to stored "fancy".
      difficulty: "easy,hard",
      highProtein: "true",
      maxCalories: "600",
      tag: "course-turkey",
      sort: "quickest",
      limit: "30",
      cursor: "abc",
    });
  });

  test("a one-character query is no query (the server would 400 it)", () => {
    assert.equal(effectiveQuery("t"), null);
    assert.equal(effectiveQuery(" t "), null);
    assert.equal(effectiveQuery("tu"), "tu");
    assert.equal(buildCookbookQuery({ q: "t" }), "");
  });

  test("equal filters in any order make the same string (it is the cache key)", () => {
    const a = buildCookbookQuery({ filters: f({ cuisines: ["thai", "indian"], difficulty: ["hard", "easy"] }) });
    const b = buildCookbookQuery({ filters: f({ cuisines: ["indian", "thai"], difficulty: ["easy", "hard"] }) });
    assert.equal(a, b);
  });

  test("the query text is URL-encoded", () => {
    assert.equal(buildCookbookQuery({ q: "mac & cheese" }), "q=mac%20%26%20cheese");
  });
});

describe("the Filters badge", () => {
  test("counts one per selected value", () => {
    assert.equal(activeFilterCount(EMPTY_FILTERS), 0);
    assert.equal(hasAnyFilter(EMPTY_FILTERS), false);
    const all = f({
      cuisines: ["thai", "indian"],
      maxMinutes: 30,
      maxActiveMinutes: 15,
      difficulty: ["easy"],
      highProtein: true,
      under600: true,
    });
    assert.equal(activeFilterCount(all), 7);
    assert.equal(hasAnyFilter(all), true);
  });
});

describe("the quick chips — the same state the sheet edits", () => {
  const [time30, easy, protein] = FIXED_QUICK_CHIPS;

  test("≤ 30 min toggles the TOTAL-time cap", () => {
    const on = toggleQuick(EMPTY_FILTERS, time30);
    assert.equal(on.maxMinutes, 30);
    assert.equal(isQuickOn(on, time30), true);
    assert.equal(toggleQuick(on, time30).maxMinutes, null);
    // A sheet choice of 45 does not light the 30 chip; tapping it sets 30.
    assert.equal(isQuickOn(f({ maxMinutes: 45 }), time30), false);
    assert.equal(toggleQuick(f({ maxMinutes: 45 }), time30).maxMinutes, 30);
  });

  test("Easy adds or removes easy and leaves other difficulties alone", () => {
    const on = toggleQuick(f({ difficulty: ["hard"] }), easy);
    assert.deepEqual(on.difficulty, ["hard", "easy"]);
    assert.equal(isQuickOn(on, easy), true);
    assert.deepEqual(toggleQuick(on, easy).difficulty, ["hard"]);
  });

  test("High protein toggles the flag", () => {
    assert.equal(toggleQuick(EMPTY_FILTERS, protein).highProtein, true);
    assert.equal(toggleQuick(f({ highProtein: true }), protein).highProtein, false);
  });

  test("cuisine chips: the top n by count, plus a selected one outside the top", () => {
    const facet = [
      { token: "italian", count: 300 },
      { token: "american", count: 200 },
      { token: "mexican", count: 100 },
      { token: "thai", count: 50 },
      { token: "greek", count: 10 },
      { token: "french", count: 0 },
    ];
    assert.deepEqual(
      cuisineQuickChips(facet, [], 3).map((c) => (c.kind === "cuisine" ? c.token : c.kind)),
      ["italian", "american", "mexican"],
    );
    assert.deepEqual(
      cuisineQuickChips(facet, ["greek"], 3).map((c) => (c.kind === "cuisine" ? c.token : c.kind)),
      ["italian", "american", "mexican", "greek"],
    );
    const thai = cuisineQuickChips(facet, [], 4)[3];
    assert.equal(isQuickOn(f({ cuisines: ["thai"] }), thai), true);
    assert.deepEqual(toggleQuick(f({ cuisines: ["thai"] }), thai).cuisines, []);
  });

  test("CLIENT-2b A: a cuisine chip needs 5 meals — quick row and sheet — unless it is selected", () => {
    assert.equal(CUISINE_CHIP_MIN, 5);
    const facet = [
      { token: "american", count: 707 },
      { token: "mexican", count: 247 },
      { token: "caribbean", count: 5 },
      { token: "brazilian", count: 4 },
      { token: "african", count: 1 },
    ];
    const quick = (sel: string[], n?: number) =>
      cuisineQuickChips(facet, sel, n).map((c) => (c.kind === "cuisine" ? c.token : c.kind));
    // Top 4 among those with 5: only three qualify.
    assert.deepEqual(quick([]), ["american", "mexican", "caribbean"]);
    assert.deepEqual(cuisineSheetTokens(facet, []), ["american", "mexican", "caribbean"]);
    // Selected and under 5 (its count dropped under the other filters): kept.
    assert.deepEqual(quick(["african"]), ["american", "mexican", "caribbean", "african"]);
    assert.deepEqual(cuisineSheetTokens(facet, ["brazilian"]), ["american", "mexican", "caribbean", "brazilian"]);
    // Selected and gone from the facet entirely: kept.
    assert.deepEqual(cuisineSheetTokens(facet, ["korean"]).slice(-1), ["korean"]);
    // Not doubled when selected and shown.
    assert.deepEqual(cuisineSheetTokens(facet, ["mexican"]), ["american", "mexican", "caribbean"]);
  });

  test("cuisine labels", () => {
    assert.equal(cuisineLabel("middle-eastern"), "Middle Eastern");
    assert.equal(cuisineLabel("tex-mex"), "Tex-Mex");
    assert.equal(cuisineLabel("bbq"), "BBQ");
    assert.equal(cuisineLabel("italian"), "Italian");
  });
});

describe("the card — the difficulty mapping and the lines", () => {
  test("stored fancy reads as Hard; the others title-case", () => {
    assert.equal(difficultyLabel("fancy"), "Hard");
    assert.equal(difficultyLabel("hard"), "Hard");
    assert.equal(difficultyLabel("easy"), "Easy");
    assert.equal(difficultyLabel("Medium"), "Medium");
  });

  test("meta line: total · hands-on · kcal, dropping what is unknown", () => {
    const m = (est: number, active: number | null, kcal: number) => ({
      estimatedTimeMinutes: est,
      activeTimeMinutes: active,
      macrosPerServing: { calories: kcal },
    });
    assert.equal(cardMetaLine(m(47, 25, 720.4)), "47 min · 25 hands-on · 720 kcal");
    assert.equal(cardMetaLine(m(47, null, 720)), "47 min · 720 kcal");
    assert.equal(cardMetaLine(m(47, 25, 0)), "47 min · 25 hands-on");
  });

  test("pills: cuisine as written, then difficulty", () => {
    assert.deepEqual(cardPills({ cuisineType: "Thai", difficulty: "fancy" }), ["Thai", "Hard"]);
    assert.deepEqual(cardPills({ cuisineType: null, difficulty: "easy" }), ["Easy"]);
  });

  test("count label", () => {
    assert.equal(mealCountLabel(1), "1 meal");
    assert.equal(mealCountLabel(1325), "1,325 meals");
    assert.equal(mealCountLabel(0), "0 meals");
  });
});
