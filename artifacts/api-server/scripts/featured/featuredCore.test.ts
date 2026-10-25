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
  resolveThx2Keys,
  sameItems,
  specFromTemplates,
  validateSpec,
  validateThanksgivingFields,
  type DumpMealRow,
  type DumpTemplateRow,
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

// ── THX-2S — the Thanksgiving fields ─────────────────────────────────────────

const THX_UNTIL = "2026-11-27T09:59:59Z"; // end of Thursday 26th in Hawaii

function thxPlan(over: Partial<SpecPlan> = {}): SpecPlan {
  return plan("thanksgiving-classic", FIVE, { anchorDate: "2026-11-26", featuredFrom: "2026-11-02T05:00:00Z", featuredUntil: THX_UNTIL, ...over });
}

describe("validateThanksgivingFields", () => {
  it("accepts a dated plan with a zoned window that ends on the anchor day", () => {
    assert.deepEqual(validateThanksgivingFields({ plans: [thxPlan()] }), []);
  });

  it("an everyday plan (no new fields) is untouched", () => {
    assert.deepEqual(validateThanksgivingFields({ plans: [plan("family-favorites", FIVE)] }), []);
  });

  it("refuses a bare-date window, an anchor without featuredUntil, and a window that outlives the anchor", () => {
    const errs = validateThanksgivingFields({
      plans: [
        thxPlan({ slug: "a", featuredUntil: "2026-11-26" }),
        thxPlan({ slug: "b", featuredUntil: undefined }),
        thxPlan({ slug: "c", featuredUntil: "2026-11-27T10:00:01Z" }),
        thxPlan({ slug: "d", anchorDate: "2026-11-31" }),
      ],
    });
    assert.equal(errs.length, 4, errs.join("\n"));
    assert.match(errs[0], /"a": featuredUntil must be a zoned ISO instant/);
    assert.match(errs[1], /"b": a dated plan needs featuredUntil/);
    assert.match(errs[2], /"c": featuredUntil .* outlives the anchor/);
    assert.match(errs[3], /"d": anchorDate must be YYYY-MM-DD/);
  });

  it("refuses mealId AND thx2Key, a non-thx2 key, and servings outside 1–30", () => {
    const p = thxPlan();
    p.days[0] = { day: "Monday", mealId: "m1", thx2Key: "thx2-feast-classic" };
    p.days[1] = { day: "Tuesday", mealId: "", thx2Key: "feast-classic" };
    p.days[3] = { day: "Thursday", mealId: "m4", servingsOverride: 0 };
    const errs = validateThanksgivingFields({ plans: [p] });
    assert.equal(errs.length, 3, errs.join("\n"));
  });
});

describe("resolveThx2Keys", () => {
  it("fills mealId from the key and reports a key that is not on the database", () => {
    const p = thxPlan();
    p.days[3] = { day: "Thursday", mealId: "", thx2Key: "thx2-feast-classic", servingsOverride: 10 };
    p.days[4] = { day: "Friday", mealId: "", thx2Key: "thx2-friday-classic" };
    const out = resolveThx2Keys({ plans: [p] }, new Map([["thx2-feast-classic", "aa18dc39"]]));
    assert.equal(out.spec.plans[0].days[3].mealId, "aa18dc39");
    assert.equal(out.spec.plans[0].days[3].servingsOverride, 10);
    assert.deepEqual(out.errors, ['"thanksgiving-classic" Friday: thx2Key thx2-friday-classic is not on this database']);
    assert.equal(p.days[3].mealId, "", "the input spec is not mutated");
  });
});

describe("desired rows carry the Thanksgiving fields", () => {
  it("anchor, window and per-item servings; an everyday plan stays all-null (zero diff)", () => {
    const p = thxPlan();
    p.days[3] = { ...p.days[3], servingsOverride: 10 };
    const t = desiredTemplate(p, 0, null);
    assert.equal(t.anchorDate?.toISOString(), "2026-11-26T00:00:00.000Z");
    assert.equal(t.featuredStartDate?.toISOString(), "2026-11-02T05:00:00.000Z");
    assert.equal(t.featuredEndDate?.toISOString(), "2026-11-27T09:59:59.000Z");
    assert.deepEqual(desiredItems(p).map((i) => i.servingsOverride), [null, null, null, 10, null]);

    const everyday = desiredTemplate(plan("family-favorites", FIVE), 0, null);
    assert.equal(everyday.anchorDate, null);
    assert.deepEqual(fieldChanges({ ...everyday }, everyday), []);
  });

  it("sameItems sees a servings change", () => {
    const p = thxPlan();
    const before = desiredItems(p);
    p.days[3] = { ...p.days[3], servingsOverride: 10 };
    assert.equal(sameItems(before, desiredItems(p)), false);
  });
});

describe("CLIENT-2 E1 — the featured and hosting flags", () => {
  it("defaults: featured on the chip and the rail, not hosting (the everyday rows unchanged)", () => {
    const t = desiredTemplate(plan("family-favorites", FIVE), 2, null);
    assert.equal(t.isFeatured, true);
    assert.equal(t.isHostingFeatured, false);
    assert.equal(t.railPosition, 3);
    assert.deepEqual(validateSpec({ plans: [plan("family-favorites", FIVE)] }), []);
  });

  it("hosting: true, featured: false → Hosting & events only, off the Home rail", () => {
    const t = desiredTemplate(thxPlan({ hosting: true, featured: false }), 0, null);
    assert.equal(t.isHostingFeatured, true);
    assert.equal(t.isFeatured, false);
    assert.equal(t.railPosition, null, "the rail's membership is railPosition, so off the chip is off the rail");
    assert.equal(t.featuredStartDate?.toISOString(), "2026-11-02T05:00:00.000Z");
  });

  it("hosting and featured together keep the rail position", () => {
    const t = desiredTemplate(thxPlan({ hosting: true, featured: true }), 4, null);
    assert.deepEqual([t.isFeatured, t.isHostingFeatured, t.railPosition], [true, true, 5]);
  });

  it("validateSpec refuses hosting without both ends of the window, and a non-boolean flag", () => {
    const errs = validateSpec({
      plans: [
        plan("a", ["a1", "a2", "a3", "a4", "a5"], { hosting: true }),
        plan("b", ["b1", "b2", "b3", "b4", "b5"], { hosting: true, featuredUntil: THX_UNTIL }),
        plan("c", ["c1", "c2", "c3", "c4", "c5"], { featured: "no" as unknown as boolean }),
        thxPlan({ slug: "d", hosting: true, featured: false }),
      ],
    });
    assert.equal(errs.length, 3, errs.join("\n"));
    assert.match(errs[0], /"a": a hosting plan needs its window/);
    assert.match(errs[1], /"b": a hosting plan needs its window/);
    assert.match(errs[2], /"c": featured must be true or false/);
  });
});

describe("checkMeals — the cuisine cap in a dated plan", () => {
  it("exempts Thursday and Friday in a dated plan only", () => {
    const rows = FIVE.map((id, i) => meal(id, { cuisineType: i >= 2 ? "american" : `c${i}` }));
    // Wed + Thu + Fri american: 3 in an everyday plan, 1 counted in a dated one.
    assert.equal(checkMeals({ plans: [plan("x", FIVE)] }, rows).length, 1);
    assert.deepEqual(checkMeals({ plans: [thxPlan()] }, rows), []);
  });
});

describe("CLIENT-2b C — specFromTemplates (the dump)", () => {
  // The Oct 26 shape: two hosting-only Thanksgiving plans off the rail, two
  // everyday plans on it at 3 and 4 (the apply's index + 1).
  const img = (id: string) => `https://img/${id}.png`;
  const row = (id: string, prefix: string, over: Partial<DumpTemplateRow> = {}): DumpTemplateRow => ({
    id: `featured-${id}`,
    title: `Plan ${id}`,
    description: "Five real dinners.",
    imageUrl: img(`${prefix}1`),
    isFeatured: true,
    isHostingFeatured: false,
    railPosition: null,
    featuredStartDate: null,
    featuredEndDate: null,
    anchorDate: null,
    items: DAYS.map((d, i) => ({ mealId: `${prefix}${i + 1}`, positionIndex: i, assignedDayOfWeek: d, servingsOverride: null })),
    ...over,
  });
  const thx = (id: string, prefix: string) =>
    row(id, prefix, {
      isFeatured: false,
      isHostingFeatured: true,
      featuredStartDate: new Date("2026-10-26T04:00:00Z"),
      featuredEndDate: new Date("2026-11-27T09:59:59Z"),
      anchorDate: new Date("2026-11-26T00:00:00Z"),
      imageUrl: img(`${prefix}4`),
      items: DAYS.map((d, i) => ({
        mealId: `${prefix}${i + 1}`,
        positionIndex: i,
        assignedDayOfWeek: d,
        servingsOverride: d === "Thursday" ? 10 : null,
      })),
    });
  const rows = [
    row("everyday-b", "b", { railPosition: 4 }),
    thx("thx-classic", "c"),
    row("everyday-a", "a", { railPosition: 3 }),
    thx("thx-small", "s"),
  ];
  const meals = new Map<string, DumpMealRow>();
  for (const pre of ["a", "b", "c", "s"]) {
    for (let i = 1; i <= 5; i++) {
      const id = `${pre}${i}`;
      const key = (pre === "c" || pre === "s") && i === 4 ? `thx2-feast-${pre}` : null;
      meals.set(id, { id, title: `Meal ${id}`, imageUrl: img(id), thx2Key: key });
    }
  }

  it("rail order: on-rail rows at railPosition − 1, off-rail rows (by id) in the slots left; flags as they stand", () => {
    const { spec, notes } = specFromTemplates(rows, meals);
    assert.deepEqual(notes, []);
    assert.deepEqual(spec.plans.map((p) => p.slug), ["thx-classic", "thx-small", "everyday-a", "everyday-b"]);
    assert.deepEqual(spec.plans.map((p) => [p.featured, p.hosting]), [[false, true], [false, true], [true, false], [true, false]]);
    const c = spec.plans[0];
    assert.equal(c.anchorDate, "2026-11-26");
    assert.equal(c.featuredFrom, "2026-10-26T04:00:00.000Z");
    assert.equal(c.featuredUntil, "2026-11-27T09:59:59.000Z");
    // The feast by key, no mealId beside it; its servings carried.
    assert.deepEqual(c.days[3], { day: "Thursday", thx2Key: "thx2-feast-c", servingsOverride: 10, name: "Meal c4" });
    assert.deepEqual(c.days[0], { day: "Monday", mealId: "c1", name: "Meal c1" });
    // The cover is Thursday's meal (named); the everyday cover is day 1 (the default, omitted).
    assert.equal(c.coverMealId, "c4");
    assert.equal(spec.plans[2].coverMealId, undefined);
    assert.equal(spec.plans[2].featuredFrom, undefined);
  });

  it("round trip: the dumped spec validates and the apply's desired rows equal the rows it came from", () => {
    const { spec } = specFromTemplates(rows, meals);
    assert.deepEqual(validateThanksgivingFields(spec), []);
    const idByKey = new Map([["thx2-feast-c", "c4"], ["thx2-feast-s", "s4"]]);
    const { spec: resolved, errors } = resolveThx2Keys(spec, idByKey);
    assert.deepEqual(errors, []);
    assert.deepEqual(validateSpec(resolved), []);
    for (const [i, p] of resolved.plans.entries()) {
      const have = rows.find((r) => r.id === `featured-${p.slug}`)!;
      const cover = meals.get(p.coverMealId ?? p.days[0].mealId)!.imageUrl;
      const want = desiredTemplate(p, i, cover);
      const fields = ["imageUrl", "isFeatured", "isHostingFeatured", "railPosition", "featuredStartDate", "featuredEndDate", "anchorDate", "title", "description"] as const;
      const pick = (o: object) => Object.fromEntries(fields.map((f) => [f, (o as Record<string, unknown>)[f]]));
      assert.deepEqual(fieldChanges(pick(have), pick(want)), [], p.slug);
      assert.ok(sameItems(have.items.map((it) => ({ ...it, isBreakfast: false, isLunch: false, isDinner: true })), desiredItems(p)), p.slug);
    }
  });

  it("what a spec cannot carry comes back as a note", () => {
    const { notes } = specFromTemplates(
      [
        row("one", "a", { railPosition: 1 }),
        row("two", "b", { railPosition: 1 }),
        row("three", "c", { railPosition: null, isFeatured: true }),
        row("four", "s", { railPosition: 4, imageUrl: "https://img/elsewhere.png" }),
      ],
      meals,
    );
    assert.ok(notes.some((n) => /featured-two: railPosition 1 cannot be its spec index/.test(n)), notes.join("\n"));
    assert.ok(notes.some((n) => /featured-three: isFeatured true with railPosition null/.test(n)), notes.join("\n"));
    assert.ok(notes.some((n) => /featured-four: no item's meal carries the template's image/.test(n)), notes.join("\n"));
  });
});
