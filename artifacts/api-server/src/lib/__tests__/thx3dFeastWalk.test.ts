// THX-3d — THE FIVE FEASTS, WALKED (dev database, opt-in: THX3D_DB=1).
//
// B (R2): every feast step amount equals its ingredient line — no corrupt unit, no
// unbound ingredient amount, no ref more than the dish lists, no count in words
// (feastAmountWalk). A (R1): Prep the feast at 4 servings makes no dry mix of fewer
// than three items, Small's crisp is two mixes (another vessel), New Twist's cheesecake
// one (the same vessel). Read-only: the prep build reads through thx2Prep's proxy,
// which refuses every write. Skipped in the hermetic suite; it reads the catalog rows
// patch.ts writes, so it runs after `patch.ts --apply` on dev.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { feastAmountFindings } from "../feastAmountWalk";

const RUN = process.env["THX3D_DB"] === "1";
const DEV_HOST = /ep-broad-haze/;
const FEASTS = ["thx2-feast-classic", "thx2-feast-small", "thx2-feast-make-ahead", "thx2-feast-vegetarian", "thx2-feast-new-twist"];

describe("THX-3d — the five dev feasts, walked", { skip: RUN ? false : "set THX3D_DB=1 to run against the dev database" }, () => {
  let prisma: PrismaClient;
  before(async () => {
    assert.ok(DEV_HOST.test(process.env["DATABASE_URL"] ?? ""), "THX3D_DB runs against the dev database only");
    const { PrismaClient: Client } = await import("@prisma/client");
    prisma = new Client();
  });
  after(async () => { await prisma?.$disconnect(); });

  const mealOf = (key: string) =>
    prisma.meal.findFirstOrThrow({
      where: { sourceType: "batch_generated", dishFamilyKey: key, isArchived: false },
      include: { dishLinks: { orderBy: { positionIndex: "asc" }, include: { dish: { include: { dishIngredients: { orderBy: { positionIndex: "asc" }, include: { ingredient: true } } } } } } },
    });

  for (const key of FEASTS) {
    it(`B — ${key}: every step amount equals its ingredient line`, async () => {
      const meal = await mealOf(key);
      const found: string[] = [];
      for (const l of meal.dishLinks) {
        const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: l.dish.id }, orderBy: { stepIndex: "asc" } });
        const rows = l.dish.dishIngredients.map((i) => ({ ingredientId: i.ingredientId, name: i.ingredient.canonicalName, quantity: i.quantity, unit: i.unit, preparationNote: i.preparationNote }));
        for (const f of feastAmountFindings(rows, steps.map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated, amountRefs: s.amountRefs })))) {
          found.push(`${l.dish.title} #${f.stepIndex} ${f.kind}: ${f.detail}`);
        }
      }
      assert.deepEqual(found, []);
    });

    it(`A — ${key}: Prep the feast at 4 servings makes no dry mix of fewer than three`, async () => {
      const dry = await dryMixes(key);
      assert.deepEqual(dry.filter((m) => m.items.length < 3).map((m) => `${m.name}: ${m.items.join(", ")}`), []);
    });
  }

  it("A — Small's apple crisp is two mixes (the filling's bowl and the topping's)", async () => {
    const crisp = (await dryMixes("thx2-feast-small")).filter((m) => m.name.startsWith("Apple Crisp"));
    assert.equal(crisp.length, 2);
    assert.ok(crisp.some((m) => m.items.includes("old-fashioned rolled oats") && !m.items.includes("cornstarch")));
    assert.ok(crisp.some((m) => m.items.includes("cornstarch") && !m.items.includes("old-fashioned rolled oats")));
  });

  it("A — New Twist's cheesecake sugar and spices are one mix (one vessel)", async () => {
    const bars = (await dryMixes("thx2-feast-new-twist")).filter((m) => m.name.startsWith("Pumpkin Cheesecake Bars"));
    assert.equal(bars.length, 1);
    assert.ok(bars[0].items.some((i) => /sugar/i.test(i)) && bars[0].items.some((i) => /cinnamon/i.test(i)));
  });

  async function dryMixes(key: string): Promise<{ name: string; items: string[] }[]> {
    const { readOnlyPrisma, PREP_WEEK_START, PREP_READ_AT } = await import("../../../scripts/thx2/thx2Prep");
    const { loadPrepWeekInput } = await import("../prepWeekAggregation");
    const { buildFeastSession } = await import("../prepWeekBuild");
    const meal = await mealOf(key);
    const plan = {
      id: `thx-3d-${key}`, userId: "thx-3d-walk", titleOverride: meal.title, startDate: PREP_WEEK_START, revisionId: 0,
      items: [{ id: "thx-3d-item", mealId: meal.id, positionIndex: 0, assignedDayOfWeek: "Thursday", servingsOverride: 4, meal }],
    };
    const load = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma: readOnlyPrisma(prisma, plan), now: PREP_READ_AT });
    const build = buildFeastSession(load)!;
    return build.stepPlan.steps
      .filter((s) => !s.demoted && s.phase === "seasonings_dry")
      .map((s) => ({ name: s.bowlName ?? s.stepKey, items: s.components.map((c) => c.ingredientName) }));
  }
});
