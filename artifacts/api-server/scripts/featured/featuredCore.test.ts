// THX-1 — the pure rules of the Featured-rail data script. No database.
//
//   node --import tsx --test scripts/featured/featuredCore.test.ts
//
// (scripts/** is outside the package's `pnpm test` glob, which covers src/
// only — run this file directly.)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  OWNER,
  checkMeals,
  desiredItems,
  desiredTemplate,
  fieldChanges,
  sameItems,
  validateSpec,
  type MealCheckRow,
  type Spec,
  type SpecPlan,
} from "./featuredCore";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function plan(slug: string, mealIds: string[], over: Partial<SpecPlan> = {}): SpecPlan {
  return {
    slug,
    title: "A Plan",
    description: "Five real dinners.",
    days: mealIds.map((mealId, i) => ({ day: DAYS[i] ?? `Day${i}`, mealId })),
    ...over,
  };
}

function meal(id: string, over: Partial<MealCheckRow> = {}): MealCheckRow {
  return {
    id,
    title: `Meal ${id}`,
    cuisineType: `Cuisine ${id}`,
    isPublic: true,
    isArchived: false,
    imageUrl: `https://img/${id}.jpg`,
    activeTimeMinutes: 30,
    userId: null,
    ...over,
  };
}

const FIVE = ["m1", "m2", "m3", "m4", "m5"];
const FIVE_ROWS = FIVE.map((id) => meal(id));

describe("validateSpec", () => {
  it("accepts a well-formed plan", () => {
    assert.deepEqual(validateSpec({ plans: [plan("family-favorites", FIVE)] }), []);
  });

  it("the shipped featured-plans.json is valid", () => {
    const spec = JSON.parse(
      readFileSync(new URL("./featured-plans.json", import.meta.url), "utf8"),
    ) as Spec;
    assert.deepEqual(validateSpec(spec), []);
    assert.equal(spec.plans.length, 5);
  });

  it("refuses a title over 42 characters, and accepts exactly 42", () => {
    const at = "x".repeat(42);
    assert.deepEqual(validateSpec({ plans: [plan("a", FIVE, { title: at })] }), []);
    const errs = validateSpec({ plans: [plan("a", FIVE, { title: at + "y" })] });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /43 characters \(max 42\)/);
  });

  it("refuses four days, and six days", () => {
    assert.match(validateSpec({ plans: [plan("a", FIVE.slice(0, 4))] }).join("\n"), /4 days/);
    assert.match(validateSpec({ plans: [plan("a", [...FIVE, "m6"])] }).join("\n"), /6 days/);
  });

  it("refuses days out of Monday–Friday order", () => {
    const p = plan("a", FIVE);
    p.days[0].day = "Tuesday";
    p.days[1].day = "Monday";
    const errs = validateSpec({ plans: [p] });
    assert.equal(errs.length, 2);
    assert.match(errs[0], /day 1 is "Tuesday" \(expected Monday\)/);
  });

  it("refuses a meal repeated inside a plan", () => {
    const errs = validateSpec({ plans: [plan("a", ["m1", "m1", "m3", "m4", "m5"])] });
    assert.match(errs.join("\n"), /m1 appears twice in the plan/);
  });

  it("refuses a meal repeated across plans, naming both plans", () => {
    const errs = validateSpec({
      plans: [plan("a", FIVE), plan("b", ["m6", "m7", "m8", "m9", "m1"])],
    });
    assert.deepEqual(errs, ['"b": meal m1 is already in "a" (no meal in two plans)']);
  });

  it("refuses a cover meal that is not in the plan", () => {
    const errs = validateSpec({ plans: [plan("a", FIVE, { coverMealId: "m9" })] });
    assert.match(errs.join("\n"), /coverMealId m9 is not one of the plan's meals/);
  });

  it("refuses a duplicate slug and an empty description", () => {
    const errs = validateSpec({
      plans: [plan("a", FIVE), plan("a", ["m6", "m7", "m8", "m9", "m10"], { description: " " })],
    });
    assert.match(errs.join("\n"), /slug appears twice/);
    assert.match(errs.join("\n"), /description is empty/);
  });

  it("reports EVERY spec error, not just the first", () => {
    const errs = validateSpec({
      plans: [plan("Bad Slug", FIVE.slice(0, 3), { title: "x".repeat(50), description: "" })],
    });
    assert.ok(errs.length >= 4, errs.join("\n"));
  });
});

describe("checkMeals — the abort rule", () => {
  const spec: Spec = { plans: [plan("a", FIVE)] };

  it("passes when every meal is present, public, live, pictured, timed and catalog-owned", () => {
    assert.deepEqual(checkMeals(spec, FIVE_ROWS), []);
  });

  it("lists EVERY failure across every meal, not just the first", () => {
    const rows = [
      meal("m1", { isPublic: false }),
      meal("m2", { isArchived: true }),
      meal("m3", { imageUrl: null }),
      meal("m4", { activeTimeMinutes: null }),
      // m5 missing entirely
    ];
    const f = checkMeals(spec, rows);
    assert.equal(f.length, 5, f.join("\n"));
    assert.match(f[0], /m1 "Meal m1": not public/);
    assert.match(f[1], /m2 "Meal m2": archived/);
    assert.match(f[2], /m3 "Meal m3": no image/);
    assert.match(f[3], /m4 "Meal m4": activeTimeMinutes is null/);
    assert.match(f[4], /m5: meal does not exist on this database/);
  });

  it("one meal with several problems reports each of them", () => {
    const rows = [meal("m1", { isPublic: false, imageUrl: null }), ...FIVE_ROWS.slice(1)];
    assert.equal(checkMeals(spec, rows).length, 2);
  });

  it("refuses a user-owned meal (its owner's DELETE /me would hit the RESTRICT)", () => {
    const rows = [meal("m1", { userId: "u-1" }), ...FIVE_ROWS.slice(1)];
    assert.match(checkMeals(spec, rows).join("\n"), /owned by user u-1/);
  });

  it("allows two meals of one cuisine and refuses three", () => {
    const two = FIVE_ROWS.map((m, i) => (i < 2 ? { ...m, cuisineType: "Italian" } : m));
    assert.deepEqual(checkMeals(spec, two), []);
    const three = FIVE_ROWS.map((m, i) => (i < 3 ? { ...m, cuisineType: "Italian" } : m));
    assert.deepEqual(checkMeals(spec, three), ['"a": 3 meals are Italian (max 2 per cuisine)']);
  });

  it("names the spec's own label for a meal missing on this database", () => {
    const s: Spec = { plans: [{ ...plan("a", FIVE), days: plan("a", FIVE).days.map((d) => ({ ...d, name: `N ${d.mealId}` })) }] };
    assert.match(checkMeals(s, FIVE_ROWS.slice(1)).join("\n"), /m1 \(N m1\): meal does not exist/);
  });
});

describe("desired rows", () => {
  const p = plan("family-favorites", FIVE, { title: " Family Favorites " });

  it("a rail template: public, featured, not hosting, railPosition by spec order, no window, five days, curated owner", () => {
    const t = desiredTemplate(p, 2, "https://img/cover.jpg");
    assert.equal(t.railPosition, 3);
    assert.equal(t.isPublic, true);
    assert.equal(t.isArchived, false);
    assert.equal(t.isFeatured, true);
    assert.equal(t.isHostingFeatured, false);
    assert.equal(t.featuredStartDate, null);
    assert.equal(t.featuredEndDate, null);
    assert.equal(t.defaultDaysCount, 5);
    assert.equal(t.imageUrl, "https://img/cover.jpg");
    assert.equal(t.userId, OWNER.id);
    assert.equal(t.title, "Family Favorites");
    assert.equal(t.displayTitle, null);
  });

  it("five Monday–Friday dinner items in order", () => {
    const items = desiredItems(p);
    assert.deepEqual(items.map((i) => i.assignedDayOfWeek), DAYS);
    assert.deepEqual(items.map((i) => i.positionIndex), [0, 1, 2, 3, 4]);
    assert.ok(items.every((i) => i.isDinner && !i.isLunch && !i.isBreakfast));
  });

  it("the owner cannot sign in: blocked, and no password", () => {
    assert.equal(OWNER.accountStatus, "blocked");
    assert.equal("passwordHash" in OWNER, false);
  });
});

describe("idempotence helpers", () => {
  it("fieldChanges is empty when the row already carries the values (Dates and arrays compared by value)", () => {
    const want = { a: 1, d: new Date("2026-10-12T00:00:00Z"), t: ["x"], n: null as string | null };
    const have = { a: 1, d: new Date("2026-10-12T00:00:00Z"), t: ["x"], n: null, extra: "ignored" };
    assert.deepEqual(fieldChanges(have, want), []);
    assert.deepEqual(fieldChanges({ ...have, a: 2 }, want), ["a: 2 -> 1"]);
  });

  it("sameItems ignores row order but not content", () => {
    const items = desiredItems(plan("a", FIVE));
    assert.equal(sameItems([...items].reverse(), items), true);
    assert.equal(sameItems(items.slice(1), items), false);
    assert.equal(sameItems(items.map((i, k) => (k === 0 ? { ...i, mealId: "zz" } : i)), items), false);
  });
});
