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

  it("N — a closing line says a shared tub's label as its food (Small's crisp filling mix: \"and lemon juice\")", async () => {
    const b = await feastBuild("thx2-feast-small");
    const lines = [...(b.closingLines ?? new Map<string, string>()).values()];
    const crisp = lines.find((l) => l.startsWith("That's the Crisp filling mix"));
    assert.ok(crisp, lines.join("\n"));
    assert.match(crisp, /\blemon juice\b/);
    assert.doesNotMatch(crisp, /Lemon juice/);
  });

  it("M — a weeknight's held cut (WEEK device · hh2, Friday) leads its dish with how it waits", async () => {
    const { weeknightMorningFor } = await import("../heldCookDay");
    const plan = await prisma.mealPlanInstance.findFirst({
      where: { titleOverride: "WEEK device · hh2", isArchived: false },
      select: { id: true, userId: true, items: { where: { assignedDayOfWeek: "Friday" }, select: { mealId: true } } },
    });
    if (!plan || plan.items.length !== 1) return; // the dev week plan is made by scripts/_scratch/thx-3d/weekPlans.ts
    const mealId = plan.items[0].mealId;
    const links = await prisma.mealDishLink.findMany({ where: { mealId }, select: { dishId: true } });
    const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: links.map((l) => l.dishId) } }, select: { ownerId: true, stepIndex: true, stepTextTranslated: true, estimatedMinutes: true, phaseType: true } });
    const morning = await weeknightMorningFor(prisma, {
      planId: plan.id, userId: plan.userId, mealId,
      dishes: links.map((l) => ({ dishId: l.dishId, steps: steps.filter((s) => s.ownerId === l.dishId).map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType })) })),
    });
    const broccoli = [...morning.values()][0];
    assert.ok(broccoli, "Friday's broccoli is reshaped");
    // PREP-3 (R3) — the lemon is in the week's one lemon-juice tub, which keeps 6 days (J.1,
    // FoodKeeper): squeezed with the week, not that morning. The florets still wait.
    assert.ok(!broccoli.some((s) => /^Juice ½ lemon/.test(s.text)), broccoli.map((s) => s.text).join(" | "));
    assert.match(broccoli[0].text, /broccoli into bite-sized florets.*; keep them covered in the fridge until it's time to cook\.$/);
  });

  it("S — the oven blocks as late as they can be: Vegetarian's stuffing and mac wait about 45 minutes, not 75–80, and the Wellington comes out to rest just before serving", async () => {
    const { thursdaySchedule } = await import("../../../scripts/thx2/thx2Oven");
    const { isOvenStep, isReheatStep } = await import("../cookingScheduler");
    const meal = await prisma.meal.findFirstOrThrow({
      where: { sourceType: "batch_generated", dishFamilyKey: "thx2-feast-vegetarian", isArchived: false },
      select: { dishLinks: { select: { positionIndex: true, roleLabel: true, dish: { select: { id: true, title: true } } } } },
    });
    const dishes = meal.dishLinks.map((l) => ({ dishId: l.dish.id, title: l.dish.title, positionIndex: l.positionIndex, roleLabel: l.roleLabel }));
    const rows = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishes.map((d) => d.dishId) } } });
    const { schedulerDishes, result } = thursdaySchedule(dishes, rows as never);
    const at = new Map(result.steps.map((e) => [`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes]));
    for (const d of schedulerDishes) {
      const reheat = d.steps.find((s) => isReheatStep(s));
      if (!reheat) continue;
      const last = [...d.steps].filter((s) => isOvenStep(s) && !isReheatStep(s) && s.phaseType !== "preheat").pop()!;
      const hold = at.get(`${d.dishId}#${reheat.stepIndex}`)! - (at.get(`${d.dishId}#${last.stepIndex}`)! + last.estimatedMinutes);
      assert.ok(hold <= 55, `${d.title} waits ${hold} minutes`);
    }
    const well = schedulerDishes.find((d) => /Wellington/.test(d.title))!;
    const bake = [...well.steps].filter((s) => isOvenStep(s) && s.phaseType !== "preheat").pop()!;
    const rest = well.steps.find((s) => s.stepIndex > bake.stepIndex && s.phaseType === "rest")!;
    const restEnd = at.get(`${well.dishId}#${rest.stepIndex}`)! + rest.estimatedMinutes;
    assert.ok(restEnd >= -10, `the Wellington's rest ends at T${restEnd}`);
  });

  async function thursdayOf(key: string) {
    const { thursdaySchedule } = await import("../../../scripts/thx2/thx2Oven");
    const meal = await prisma.meal.findFirstOrThrow({
      where: { sourceType: "batch_generated", dishFamilyKey: key, isArchived: false },
      select: { dishLinks: { select: { positionIndex: true, roleLabel: true, dish: { select: { id: true, title: true } } } } },
    });
    const dishes = meal.dishLinks.map((l) => ({ dishId: l.dish.id, title: l.dish.title, positionIndex: l.positionIndex, roleLabel: l.roleLabel }));
    const rows = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishes.map((d) => d.dishId) } } });
    const { schedulerDishes, result } = thursdaySchedule(dishes, rows as never);
    const at = (dishId: string, stepIndex: number) => result.steps.find((e) => e.dishId === dishId && e.originalStepIndex === stepIndex)?.startOffsetMinutes;
    return { schedulerDishes, result, at, rows };
  }

  it("T — New Twist bakes its sides with the bird at 400°F: in together, out 0–10 minutes before the rest ends, no early bake, no hold, no reheat", async () => {
    const { isOvenStep, isReheatStep, ovenTempOfText, HOLD_COVERED_STEP } = await import("../cookingScheduler");
    const { schedulerDishes, at } = await thursdayOf("thx2-feast-new-twist");
    const bird = schedulerDishes.find((d) => /Spatchcock/.test(d.title))!;
    const temps = schedulerDishes.flatMap((d) => d.steps.filter((s) => isOvenStep(s) && s.phaseType !== "preheat").map((s) => ovenTempOfText(s.text))).filter((t) => t !== null);
    assert.deepEqual([...new Set(temps)], [400]);
    assert.ok(schedulerDishes.every((d) => d.steps.every((s) => !isReheatStep(s) && !HOLD_COVERED_STEP.test(s.text ?? ""))), "no hold, no reheat");
    const putIn = bird.steps.find((s) => /^Put the .+ in the oven with the turkey\.$/.test(s.text ?? ""))!;
    assert.ok(putIn, "the put-in step");
    const putEnd = at(bird.dishId, putIn.stepIndex)! + putIn.estimatedMinutes;
    const roast = [...bird.steps].filter((s) => isOvenStep(s) && s.phaseType === "cook").pop()!;
    const out = at(bird.dishId, roast.stepIndex)! + roast.estimatedMinutes;
    const rest = bird.steps.find((s) => s.phaseType === "rest")!;
    assert.equal(at(bird.dishId, rest.stepIndex), out, "the bird comes out as its roast ends");
    const restEnd = out + rest.estimatedMinutes;
    for (const d of schedulerDishes.filter((x) => putIn.text!.includes(x.title))) {
      const ov = d.steps.filter((s) => isOvenStep(s) && s.phaseType !== "preheat");
      assert.equal(at(d.dishId, ov[0].stepIndex), putEnd, `${d.title} goes in at the put-in`);
      for (const s of d.steps.filter((x) => x.stepIndex < ov[0].stepIndex && x.phaseType !== "hold")) assert.ok(at(d.dishId, s.stepIndex)! < putEnd, `${d.title}: "${(s.text ?? "").slice(0, 40)}" before the put-in`);
      const end = at(d.dishId, ov[ov.length - 1].stepIndex)! + ov[ov.length - 1].estimatedMinutes;
      assert.ok(end <= restEnd && end >= restEnd - 10, `${d.title} out at T${end}, the rest ends T${restEnd}`);
    }
    const smashed = schedulerDishes.find((d) => /Smashed/.test(d.title))!;
    const first = smashed.steps.find((s) => /in at 400/.test(s.text ?? ""))!;
    assert.ok(at(smashed.dishId, first.stepIndex)! >= out, "the smashed potatoes wait for the bird to come out");
    // S/T — the bird as late as it can be: the carved turkey does not wait long for serving.
    const carve = bird.steps.find((s) => s.stepIndex > rest.stepIndex && /^Carve\b/i.test(s.text ?? ""))!;
    const carveEnd = at(bird.dishId, carve.stepIndex)! + carve.estimatedMinutes;
    assert.ok(carveEnd >= -20, `the carve ends T${carveEnd}`);
    // U — the sides are not lifted out a minute after "leave the sides inside".
    const off = schedulerDishes.flatMap((d) => d.steps.filter((s) => /^Turn the oven off and leave the sides inside/i.test(s.text ?? "")).map((s) => ({ d, s }))).find((x) => at(x.d.dishId, x.s.stepIndex) !== undefined);
    if (off) {
      const offEnd = at(off.d.dishId, off.s.stepIndex)! + off.s.estimatedMinutes;
      for (const d of schedulerDishes) {
        for (const s of d.steps.filter((x) => /^Transfer the .+ to a platter\b/i.test(x.text ?? "") && at(d.dishId, x.stepIndex) !== undefined)) {
          assert.ok(at(d.dishId, s.stepIndex)! - offEnd >= 5, `${d.title}: plated T${at(d.dishId, s.stepIndex)}, the oven off at T${offEnd}`);
        }
      }
    }
  });

  it("U — each bird's preheat and prep ride its sit: the roast begins as the sit ends (Classic, Small, New Twist)", async () => {
    for (const key of ["thx2-feast-classic", "thx2-feast-small", "thx2-feast-new-twist"]) {
      const { isOvenStep } = await import("../cookingScheduler");
      const { schedulerDishes, at } = await thursdayOf(key);
      const bird = schedulerDishes.find((d) => /Turkey/.test(d.title))!;
      const sit = bird.steps.find((s) => s.phaseType === "hold")!;
      const roast = bird.steps.find((s) => s.phaseType === "cook" && isOvenStep(s))!;
      assert.equal(at(bird.dishId, roast.stepIndex), at(bird.dishId, sit.stepIndex)! + sit.estimatedMinutes, `${key}: the roast starts as the sit ends`);
    }
  });

  async function feastSteps(key: string) {
    return (await feastBuild(key)).stepPlan.steps.filter((s) => !s.demoted);
  }

  async function feastBuild(key: string) {
    const { readOnlyPrisma, PREP_WEEK_START, PREP_READ_AT } = await import("../../../scripts/thx2/thx2Prep");
    const { loadPrepWeekInput } = await import("../prepWeekAggregation");
    const { buildFeastSession } = await import("../prepWeekBuild");
    const meal = await mealOf(key);
    const plan = {
      id: `thx-3d-s-${key}`, userId: "thx-3d-walk", titleOverride: meal.title, startDate: PREP_WEEK_START, revisionId: 0,
      items: [{ id: "thx-3d-item", mealId: meal.id, positionIndex: 0, assignedDayOfWeek: "Thursday", assignedDate: new Date("2026-11-26T00:00:00Z"), servingsOverride: null, meal }],
    };
    const load = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma: readOnlyPrisma(prisma, plan), now: PREP_READ_AT });
    return buildFeastSession(load)!;
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
