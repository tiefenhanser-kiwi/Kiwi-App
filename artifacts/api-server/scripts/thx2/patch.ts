// THX-3 — PATCH the stored Thanksgiving feasts to THX-3's code-owned rules, IN
// PLACE: the meal ids, dish ids and step ids are kept (production's featured
// templates point at these meals, so revert.ts + generate.ts cannot run there).
// No AI. Dry by default; --apply writes, one transaction per feast.
//
//   node --env-file=.env --import tsx scripts/thx2/patch.ts            # dry run: every change, the times before → after
//   node --env-file=.env --import tsx scripts/thx2/patch.ts --apply    # write it
//   node --env-file=.env --import tsx scripts/thx2/patch.ts --only thx2-feast-classic
//
// Database: assertScriptDatabase — dev, or production only when KIWI_PRODUCTION_HOST
// names the DATABASE_URL host exactly (R3-0). Idempotent: a second run reports
// nothing to change.
//
// Per feast dish, matched to targets.json by title (thx2Core.dishSpecFor):
//   1. tags        — the make-ahead family replaced by aheadTags(spec): every ahead
//                    day, the keep-days table, assemble (BUG-425, BUG-450);
//   2. a moved day — "Make ahead (Monday):" → "(Tuesday):" when the dish has one
//                    make-ahead day and targets.json names another (decision 4);
//   3. keep-days   — the model's keep clause → the table's number (BUG-450);
//   4. Thursday    — a code-written "On Thursday:" serve step for a make-ahead dish
//                    that has none (BUG-425);
//   5. amountRefs  — re-derived for every step from the dish's own rows, so the
//                    "2 days" refs (BUG-450's 1⅝) are gone (stepAmountRefs isByDesign);
// then per feast: 6. the derived times re-stamped (THX-3 B's oven, the new steps).
//
// It does not touch a user's copy of a feast (sourceStoreMealId) — it counts them.

import { Prisma, PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { deriveAmountRefs, type MatcherIngredient } from "../../src/lib/stepAmountRefs";
import { stampMealTiming } from "../../src/lib/mealTiming";
import { AHEAD_TAG, aheadDaysOf, aheadTags, dishSpecFor, keepsDaysFor, loadTargets, validateTargets } from "./thx2Core";
import { fixKeepClause, hasThursdayStep, retargetMakeAheadDay, thursdayServeStep } from "./thx2Checks";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;

const { host, mode } = assertScriptDatabase("thx2/patch");
console.log(`database: ${host} (${mode}) · ${APPLY ? "APPLY" : "DRY RUN — nothing is written"}`);

const file = loadTargets();
const errs = validateTargets(file);
if (errs.length) { console.error(`targets.json is invalid:\n  ${errs.join("\n  ")}`); process.exit(2); }
const feasts = file.targets.filter((t) => t.kind === "feast" && (!ONLY || ONLY.includes(t.key)));

const DAY = { mon: "Monday", tue: "Tuesday", wed: "Wednesday" } as const;
const MAKE_AHEAD_DAY = /^\s*Make ahead \(([A-Za-z]+)\):/i;

const prisma = new PrismaClient();

/** JSON with every object's keys sorted (jsonb does not keep insertion order). */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

interface StepRow { id: string; stepIndex: number; stepTextTranslated: string; amountRefs: Prisma.JsonValue | null; phaseType: string; estimatedMinutes: number; isTimingSensitive: boolean; parallelGroup: string | null; componentKey: string | null; pathKey: string | null }
interface Plan {
  tagUpdates: { dishId: string; title: string; from: string[]; to: string[] }[];
  textUpdates: { stepId: string; title: string; stepIndex: number; from: string; to: string }[];
  refUpdates: { stepId: string; refs: unknown; was: unknown; text: string }[];
  creates: { dishId: string; title: string; stepIndex: number; text: string; phaseType: "assemble"; estimatedMinutes: number; refs: unknown }[];
}

let totalChanges = 0;
for (const t of feasts) {
  const meal = await prisma.meal.findFirst({
    where: { sourceType: "batch_generated", dishFamilyKey: t.key, isArchived: false },
    select: {
      id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: { dishId: true, positionIndex: true, dish: { select: { id: true, title: true, tags: true, estimatedTimeMinutes: true, dishIngredients: { orderBy: { positionIndex: "asc" }, select: { quantity: true, unit: true, ingredientId: true, ingredient: { select: { canonicalName: true } } } } } } },
      },
    },
  });
  if (!meal) { console.log(`\n▷ ${t.key}: not in this database — skipped`); continue; }
  const forks = await prisma.meal.count({ where: { sourceStoreMealId: meal.id } });
  const templateRefs = await prisma.mealPlanTemplateItem.count({ where: { mealId: meal.id } });
  const planRefs = await prisma.mealPlanItem.count({ where: { mealId: meal.id } });
  console.log(`\n▶ ${t.key} ${meal.id} "${meal.title.slice(0, 70)}" · plan items ${planRefs} · template items ${templateRefs} · user copies ${forks} (not patched)`);

  const plan: Plan = { tagUpdates: [], textUpdates: [], refUpdates: [], creates: [] };
  const specOf = dishSpecFor(t);
  const stepsByDish = new Map<string, StepRow[]>();
  for (const link of meal.dishLinks) {
    const d = link.dish;
    const spec = specOf(d.title, link.positionIndex);
    const steps = (await prisma.recipeInstructionStep.findMany({
      where: { ownerType: "dish", ownerId: d.id },
      orderBy: { stepIndex: "asc" },
      select: { id: true, stepIndex: true, stepTextTranslated: true, amountRefs: true, phaseType: true, estimatedMinutes: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true },
    })) as StepRow[];
    // 1. tags
    const wantTags = [...d.tags.filter((x) => !AHEAD_TAG.test(x)), ...(spec ? aheadTags(spec) : [])];
    if (JSON.stringify(wantTags) !== JSON.stringify(d.tags)) plan.tagUpdates.push({ dishId: d.id, title: d.title, from: d.tags, to: wantTags });

    const texts = new Map(steps.map((s) => [s.id, s.stepTextTranslated]));
    if (spec?.ahead) {
      // 2. a moved make-ahead day
      const stored = [...new Set(steps.map((s) => MAKE_AHEAD_DAY.exec(s.stepTextTranslated)?.[1]).filter((x): x is string => !!x))];
      const wanted = aheadDaysOf(spec).map((x) => DAY[x]);
      if (stored.length === 1 && wanted.length === 1 && stored[0].toLowerCase() !== wanted[0].toLowerCase()) {
        for (const s of steps) texts.set(s.id, retargetMakeAheadDay(texts.get(s.id)!, stored[0], wanted[0]));
      }
      // 3. keep-days
      const keeps = keepsDaysFor(spec)!;
      for (const s of steps) texts.set(s.id, fixKeepClause(texts.get(s.id)!, keeps));
    }
    for (const s of steps) {
      const to = texts.get(s.id)!;
      if (to !== s.stepTextTranslated) plan.textUpdates.push({ stepId: s.id, title: d.title, stepIndex: s.stepIndex, from: s.stepTextTranslated, to });
    }
    // 5. amountRefs, from the dish's own rows (mealMaterialize's matcher input)
    const matcher: MatcherIngredient[] = d.dishIngredients.map((i) => ({ ingredientId: i.ingredientId, name: i.ingredient.canonicalName, quantity: i.quantity, unit: i.unit }));
    // ⚠️ ONLY where it must: a step whose text changed, or whose stored refs hold a
    // duration (BUG-450's "2 days"). Every other step keeps the refs it was written
    // with — re-deriving them from today's canonical names lost Vegetarian's
    // "1½ lb Honeycrisp apples" ref in the dry run (the generation-time names differ).
    const DURATION_AFTER = /^\s*(?:-\s*)?(?:days?|weeks?|nights?|months?)\b(?!-old)/i;
    const needsRefs = (s: StepRow) =>
      texts.get(s.id) !== s.stepTextTranslated ||
      ((Array.isArray(s.amountRefs) ? s.amountRefs : []) as { charEnd: number }[]).some((r) => DURATION_AFTER.test(s.stepTextTranslated.slice(r.charEnd, r.charEnd + 10)));
    for (const s of steps) {
      if (!needsRefs(s)) continue;
      const { amountRefs } = deriveAmountRefs(texts.get(s.id)!, matcher);
      // jsonb stores object keys in its own order, so compare key-sorted.
      if (canonical(amountRefs) !== canonical(s.amountRefs ?? null)) plan.refUpdates.push({ stepId: s.id, refs: amountRefs, was: s.amountRefs, text: texts.get(s.id)! });
    }
    // 4. a Thursday step
    if (spec?.ahead && !hasThursdayStep(steps.map((s) => texts.get(s.id)!))) {
      const step = thursdayServeStep(d.title, spec.course);
      const stepIndex = Math.max(-1, ...steps.map((s) => s.stepIndex)) + 1;
      plan.creates.push({ dishId: d.id, title: d.title, stepIndex, text: step.text, phaseType: step.phaseType, estimatedMinutes: step.estimatedMinutes, refs: deriveAmountRefs(step.text, matcher).amountRefs });
    }
    stepsByDish.set(d.id, steps.map((s) => ({ ...s, stepTextTranslated: texts.get(s.id)! })));
  }

  for (const u of plan.tagUpdates) console.log(`  tags  [${u.title}] ${u.from.join(" ") || "—"}  →  ${u.to.join(" ") || "—"}`);
  for (const u of plan.textUpdates) console.log(`  text  [${u.title} #${u.stepIndex}]\n          was: ${u.from}\n          now: ${u.to}`);
  for (const c of plan.creates) console.log(`  step+ [${c.title} #${c.stepIndex}] ${c.phaseType} ${c.estimatedMinutes}m: ${c.text}`);
  for (const u of plan.refUpdates) {
    const spans = (r: unknown) => ((Array.isArray(r) ? r : []) as { charStart: number; charEnd: number }[]).map((x) => `"${u.text.slice(x.charStart, x.charEnd)}"@${x.charStart}`).join(" ");
    console.log(`  refs  [${u.text.slice(0, 50)}…] ${spans(u.was) || "—"}  →  ${spans(u.refs) || "—"}`);
  }

  // 6. the times — stampMealTiming itself, over the PATCHED steps. Dry run: a tx that
  // answers reads from memory and captures the two writes instead of making them.
  const dishIds = meal.dishLinks.map((l) => l.dishId);
  const patchedSteps = dishIds.flatMap((id) => [
    ...(stepsByDish.get(id) ?? []).map((s) => ({ ...s, ownerId: id })),
    ...plan.creates.filter((c) => c.dishId === id).map((c) => ({ ownerId: id, stepIndex: c.stepIndex, estimatedMinutes: c.estimatedMinutes, phaseType: c.phaseType, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null, stepTextTranslated: c.text })),
  ]);
  const captured: { meal?: { estimatedTimeMinutes: number | null; activeTimeMinutes: number | null } } = {};
  const memoryTx = {
    recipeInstructionStep: { findMany: async () => [...patchedSteps].sort((a, b) => (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : a.stepIndex - b.stepIndex)) },
    mealDishLink: { findMany: async () => meal.dishLinks.map((l) => ({ dishId: l.dishId, positionIndex: l.positionIndex, meal: { tags: ["thanksgiving-feast"] } })) },
    meal: { update: async (a: { data: { estimatedTimeMinutes: number | null; activeTimeMinutes: number | null } }) => { captured.meal = a.data; return a; } },
    dish: { update: async (a: unknown) => a },
  } as unknown as Prisma.TransactionClient;
  await stampMealTiming(memoryTx, meal.id, dishIds);
  const timeChanged = captured.meal && (captured.meal.estimatedTimeMinutes !== meal.estimatedTimeMinutes || captured.meal.activeTimeMinutes !== meal.activeTimeMinutes);
  console.log(`  time  total ${meal.estimatedTimeMinutes} → ${captured.meal?.estimatedTimeMinutes} · hands-on ${meal.activeTimeMinutes} → ${captured.meal?.activeTimeMinutes}`);

  const changes = plan.tagUpdates.length + plan.textUpdates.length + plan.refUpdates.length + plan.creates.length + (timeChanged ? 1 : 0);
  totalChanges += changes;
  if (!APPLY || changes === 0) continue;

  await prisma.$transaction(async (tx) => {
    for (const u of plan.tagUpdates) await tx.dish.update({ where: { id: u.dishId }, data: { tags: u.to } });
    for (const u of plan.textUpdates) await tx.recipeInstructionStep.update({ where: { id: u.stepId }, data: { stepTextRaw: u.to, stepTextTranslated: u.to } });
    for (const u of plan.refUpdates) await tx.recipeInstructionStep.update({ where: { id: u.stepId }, data: { amountRefs: u.refs as Prisma.InputJsonValue } });
    for (const c of plan.creates) {
      await tx.recipeInstructionStep.create({
        data: { ownerType: "dish", ownerId: c.dishId, stepIndex: c.stepIndex, stepTextRaw: c.text, stepTextTranslated: c.text, phaseType: c.phaseType, estimatedMinutes: c.estimatedMinutes, isTimingSensitive: false, amountRefs: c.refs as Prisma.InputJsonValue },
      });
    }
    await stampMealTiming(tx, meal.id, dishIds);
  }, { timeout: 60_000 });
  console.log(`  ✅ applied`);
}

console.log(`\n${APPLY ? "applied" : "would apply"} ${totalChanges} change(s) across ${feasts.length} feast target(s)${APPLY ? "" : " — re-run with --apply"}`);
await prisma.$disconnect();
