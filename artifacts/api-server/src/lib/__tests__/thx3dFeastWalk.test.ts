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
    // (Round 2 N — their labels: "Crisp topping mix", "Crisp filling mix".)
    const crisp = (await dryMixes("thx2-feast-small")).filter((m) => m.name.startsWith("Crisp"));
    assert.equal(crisp.length, 2);
    assert.ok(crisp.some((m) => m.items.includes("old-fashioned rolled oats") && !m.items.includes("cornstarch")));
    assert.ok(crisp.some((m) => m.items.includes("cornstarch") && !m.items.includes("old-fashioned rolled oats")));
  });

  // Round 2 (L) — reversed: the filling's sugar was beaten in two steps before the spices
  // were measured, and the mix that held it went in too ("double sugar"). The spices are
  // measured on their own, so they are the mix; the sugar is the step's.
  it("A/L — New Twist's cheesecake: the spices are the mix, the filling's sugar is not in it", async () => {
    const bars = (await dryMixes("thx2-feast-new-twist")).filter((m) => m.name.startsWith("Cheesecake"));
    assert.equal(bars.length, 1);
    assert.ok(!bars[0].items.some((i) => /sugar/i.test(i)) && bars[0].items.some((i) => /cinnamon/i.test(i)), bars[0].items.join(", "));
  });

  it("L — New Twist's lime is its own citrus, never the glaze jar that went on the potatoes 35 minutes before", async () => {
    const steps = await feastSteps("thx2-feast-new-twist");
    const lime = steps.flatMap((s) => s.components.filter((c) => /\blime\b/i.test(c.ingredientName)).flatMap((c) => c.measures));
    assert.ok(lime.length > 0, "the lime is prepped");
    assert.ok(lime.every((m) => !/sauce/i.test(m.destination ?? "")), lime.map((m) => m.destination).join(", "));
  });

  it("L — Classic's cavity celery is prepped, with the turkey's onion and lemon", async () => {
    const steps = await feastSteps("thx2-feast-classic");
    const celery = steps.flatMap((s) => s.components.filter((c) => /\bcelery\b/i.test(c.ingredientName)).flatMap((c) => c.measures)).filter((m) => /turkey/i.test(m.forDish));
    assert.equal(celery.length, 1, "the turkey's celery is in Prep the feast");
    assert.match(celery[0].destination ?? "", /^Turkey/);
  });

  async function feastSteps(key: string) {
    const { readOnlyPrisma, PREP_WEEK_START, PREP_READ_AT } = await import("../../../scripts/thx2/thx2Prep");
    const { loadPrepWeekInput } = await import("../prepWeekAggregation");
    const { buildFeastSession } = await import("../prepWeekBuild");
    const meal = await mealOf(key);
    const plan = {
      id: `thx-3d-s-${key}`, userId: "thx-3d-walk", titleOverride: meal.title, startDate: PREP_WEEK_START, revisionId: 0,
      items: [{ id: "thx-3d-item", mealId: meal.id, positionIndex: 0, assignedDayOfWeek: "Thursday", assignedDate: new Date("2026-11-26T00:00:00Z"), servingsOverride: null, meal }],
    };
    const load = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma: readOnlyPrisma(prisma, plan), now: PREP_READ_AT });
    return buildFeastSession(load)!.stepPlan.steps.filter((s) => !s.demoted);
  }

  // Round 2 (L) — the wording walk (feastWordingWalk): Cook Mode names what Prep the feast
  // made by its container, and a food is in a mix or in a step, never both for one moment.
  for (const key of FEASTS) {
    it(`L — ${key}: no step adds a prepped food loose; no food is in a mix and a step for one moment`, async () => {
      const { readOnlyPrisma, PREP_WEEK_START, PREP_READ_AT } = await import("../../../scripts/thx2/thx2Prep");
      const { loadPrepWeekInput } = await import("../prepWeekAggregation");
      const { buildFeastSession } = await import("../prepWeekBuild");
      const { feastDishFacts, rewordFeastSteps } = await import("../feastCookWording");
      const { feastWordingFindings } = await import("../feastWordingWalk");
      const meal = await mealOf(key);
      const plan = {
        id: `thx-3d-L-${key}`, userId: "thx-3d-walk", titleOverride: meal.title, startDate: PREP_WEEK_START, revisionId: 0,
        items: [{ id: "thx-3d-item", mealId: meal.id, positionIndex: 0, assignedDayOfWeek: "Thursday", assignedDate: new Date("2026-11-26T00:00:00Z"), servingsOverride: null, meal }],
      };
      const load = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma: readOnlyPrisma(prisma, plan), now: PREP_READ_AT });
      const facts = feastDishFacts(buildFeastSession(load)!);
      const titles = meal.dishLinks.map((l) => l.dish.title);
      const found: string[] = [];
      for (const l of meal.dishLinks) {
        const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: l.dish.id }, orderBy: { stepIndex: "asc" } });
        const rows = l.dish.dishIngredients.map((i) => ({ ingredientId: i.ingredientId, name: i.ingredient.canonicalName, quantity: i.quantity, unit: i.unit }));
        const worded = rewordFeastSteps(steps.map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated, amountRefs: (s.amountRefs as never) ?? null })), rows, facts.get(l.dish.id), titles);
        for (const f of feastWordingFindings(worded, rows, facts.get(l.dish.id), titles)) found.push(`${f.kind} [${l.dish.title} #${f.stepIndex}] ${f.detail}`);
      }
      assert.deepEqual(found, []);
    });
  }

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
      .filter((s) => !s.demoted && s.phase === "seasonings_dry" && !s.fixedProse) // (not the "Label N containers" step)
      .map((s) => ({ name: s.bowlName ?? s.stepKey, items: s.components.map((c) => c.ingredientName) }));
  }

  // D (R4) — Thursday through the route's own runCookingSequence (a proxy reports the
  // non-public catalog meal public, as a fork is). Small's carve slipped 10 minutes behind
  // its 20-minute rest once the green-bean split moved the stove work; this pins all five.
  for (const key of FEASTS) {
    it(`D — ${key}: the bird is carved as its rest ends; one serve step, last; dessert after it`, async () => {
      const { runCookingSequence } = await import("../cookingSequence");
      const meal = await mealOf(key);
      const publicMeal = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "meal") return { findUnique: async (a: unknown) => { const m = await (prisma.meal.findUnique as (x: unknown) => Promise<Record<string, unknown> | null>)(a); return m ? { ...m, isPublic: true } : m; } };
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as PrismaClient;
      const r = await runCookingSequence({ mealId: meal.id, userId: "thx-3d-walk", deps: { prisma: publicMeal } });
      const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: meal.dishLinks.map((l) => l.dish.id) } } });
      const row = (s: { dishId: string; originalStepIndex: number }) => steps.find((x) => x.ownerId === s.dishId && x.stepIndex === s.originalStepIndex)!;
      const seq = r.sequence.map((s) => ({ ...s, row: row(s) }));
      const serve = seq.filter((s) => /^Serve the .+ with the /.test(s.row.stepTextTranslated));
      assert.equal(serve.length, 1, "one serve step");
      const last = serve[0].startOffsetMinutes;
      const dessertIds = new Set(meal.dishLinks.filter((l) => /\b(pie|crisp|cheesecake|bars|cake|cobbler|tart)\b/i.test(l.dish.title)).map((l) => l.dish.id));
      for (const s of seq) {
        // Dessert may bake beside the bird; it is plated after the serve.
        if (dessertIds.has(s.dishId)) { if (s.row.phaseType === "assemble") assert.ok(s.startOffsetMinutes >= last, `${s.row.stepTextTranslated.slice(0, 60)} is dessert, after the serve`); }
        else if (s !== serve[0]) assert.ok(s.startOffsetMinutes <= last, `${s.row.stepTextTranslated.slice(0, 60)} after the serve step`);
      }
      const bird = meal.dishLinks.find((l) => /\bturkey\b/i.test(l.dish.title));
      if (!bird) return; // Vegetarian: no bird
      const mine = seq.filter((s) => s.dishId === bird.dish.id).sort((a, b) => a.originalStepIndex - b.originalStepIndex);
      const rest = mine.find((s) => s.row.phaseType === "rest");
      const carve = mine.find((s) => /^Carve the /i.test(s.row.stepTextTranslated));
      assert.ok(rest && carve, "a rest and a carve");
      assert.equal(carve!.startOffsetMinutes, rest!.startOffsetMinutes + rest!.row.estimatedMinutes, `${key}: carved as the rest ends`);
    });
  }
});
