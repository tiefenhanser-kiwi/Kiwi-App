// SERVER-10 G (D-WS9-349) — the dev Thanksgiving templates: resolution and rows.
//   node --import tsx --test scripts/thx2/devTemplatesCore.test.ts   (from artifacts/api-server)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEV_ALSO_FEATURED, devTemplateRows, resolveDays, type DevMealRow, type DevSpec } from "./devTemplatesCore";

const spec = JSON.parse(readFileSync(new URL("./dev-templates.json", import.meta.url), "utf8")) as DevSpec;

/** Every day of the committed spec, present once on a fake dev. */
function devMeals(): DevMealRow[] {
  return spec.plans.flatMap((p) =>
    p.days.map((d) => ({
      id: d.mealId ?? `id:${d.dishFamilyKey}`,
      dishFamilyKey: d.dishFamilyKey ?? null,
      imageUrl: d.day === p.coverDay ? `https://img/${p.slug}.png` : null,
      isArchived: false,
    })),
  );
}

describe("SERVER-10 G — production's five Thanksgiving templates, for dev", () => {
  it("the committed spec: five anchored hosting plans, Monday to Friday, the Thursday feast at 10 from production's copy", () => {
    assert.equal(spec.plans.length, 5);
    for (const p of spec.plans) {
      assert.equal(p.anchorDate, "2026-11-26");
      assert.equal(p.hosting, true);
      assert.equal(p.featured, false, "production's own: off the Featured chip");
      assert.deepEqual(p.days.map((d) => d.day), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
      const thu = p.days.find((d) => d.day === "Thursday")!;
      assert.match(thu.dishFamilyKey ?? "", /^prodcopy:thx2-feast-/);
      assert.ok(thu.servingsOverride && thu.servingsOverride >= 4);
    }
    assert.deepEqual(spec.plans.map((p) => p.title), [
      "The Classic Thanksgiving", "A Small Thanksgiving", "The Make-Ahead Thanksgiving", "A Vegetarian Friendsgiving", "Thanksgiving, With a Twist",
    ]);
  });

  it("rows: production's fields, plus the Featured chip on dev; never on the Home rail", () => {
    const meals = devMeals();
    const { mealIdOf, problems } = resolveDays(spec, meals);
    assert.deepEqual(problems, []);
    const rows = devTemplateRows(spec, mealIdOf, meals);
    assert.deepEqual(rows.map((r) => r.id), spec.plans.map((p) => `featured-${p.slug}`));
    for (const r of rows) {
      assert.equal(r.want.isFeatured, DEV_ALSO_FEATURED.isFeatured);
      assert.equal(r.want.isHostingFeatured, true);
      assert.equal(r.want.railPosition, null);
      assert.equal(r.want.isPublic, true);
      assert.equal(r.want.anchorDate?.toISOString().slice(0, 10), "2026-11-26");
      assert.equal(r.items.length, 5);
    }
    const classic = rows[0];
    assert.equal(classic.want.imageUrl, "https://img/thanksgiving-classic.png", "the feast's image is the cover");
    const thu = classic.items.find((i) => i.assignedDayOfWeek === "Thursday")!;
    assert.equal(thu.mealId, "id:prodcopy:thx2-feast-classic");
    assert.equal(thu.servingsOverride, 10);
  });

  it("refuses a missing, an ambiguous or an archived meal, and says which", () => {
    const meals = devMeals();
    const missing = meals.filter((m) => m.dishFamilyKey !== "thx2-friday-small");
    assert.match(resolveDays(spec, missing).problems.join("\n"), /thanksgiving-small Friday: no meal thx2-friday-small/);
    const twice = [...meals, { ...meals.find((m) => m.dishFamilyKey === "prodcopy:thx2-feast-classic")!, id: "other" }];
    assert.match(resolveDays(spec, twice).problems.join("\n"), /thanksgiving-classic Thursday: 2 meals carry/);
    const archived = meals.map((m) => (m.dishFamilyKey === "thx2-friday-new-twist" ? { ...m, isArchived: true } : m));
    assert.match(resolveDays(spec, archived).problems.join("\n"), /thanksgiving-new-twist Friday: meal .* is archived/);
  });
});
