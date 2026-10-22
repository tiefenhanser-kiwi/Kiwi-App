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
// then per feast: 6. the derived times re-stamped (THX-3 B's oven, the new steps);
//   7. THX-3b (BUG-457) — ONE OVEN TEMPERATURE AFTER THE BIRD (thx2Oven.ts): every
//      post-bird oven step is printed (dish · °F · start → end), and a side baking at
//      another temperature than the rest moves to it, its times adjusted (≤ 25°F; a
//      bigger move is REFUSED and printed — that is more than a time change).
//   8. THX-3c (F) — a step that adds cut food names its amount (thx2Amounts.ts), and
//      only those steps' refs are re-derived. `bird` lines say how each feast's bird
//      is written (BUG-462).
//
// It does not touch a user's copy of a feast (sourceStoreMealId) — it counts them.

import { Prisma, PrismaClient, type StepPhase } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { deriveAmountRefs, type MatcherIngredient } from "../../src/lib/stepAmountRefs";
import { stampMealTiming } from "../../src/lib/mealTiming";
import { isWholeBirdByCount, isWholeBirdByWeight } from "../../src/lib/prepQuantity";
import { nameCutAmounts, repairShapeCounts } from "./thx2Amounts";
import { AHEAD_TAG, aheadDaysOf, aheadTags, dishSpecFor, keepsDaysFor, loadTargets, validateTargets } from "./thx2Core";
import { fixKeepClause, retargetMakeAheadDay } from "./thx2Checks";
import { thursdayPostPass, thursdayPrePass, type ThursdayEdits } from "./thx2Thursday";
import { countsInWords, mergeRefs, missingRows } from "./thx2Rows";
import { thawStepText } from "../../src/lib/feastAddedDish";
import { splitPrepClause } from "../../src/lib/feastCookWording";
import { formatOvenReport, heldDishSteps, holdTextUpdates, oneOvenTemperature, ovenReport, retimeDish, splitPreheatSteps, type OvenStepRow } from "./thx2Oven";

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
  creates: { dishId: string; title: string; stepIndex: number; text: string; phaseType: "assemble" | "cook" | "preheat" | "prep" | "hold"; estimatedMinutes: number; refs: unknown; componentKey?: string | null; pathKey?: string | null }[];
  /** THX-3d (D) — a step removed (a side's redundant preheat, a serve-only step, THX-3c's old raise). */
  deletes: { stepId: string; title: string; stepIndex: number; text: string }[];
  /** THX-3d (D) — a step's phase changed (the sit is a hold). */
  phaseUpdates: { stepId: string; title: string; stepIndex: number; from: string; to: string }[];
  /** THX-3c — a step moved one down to make room for a code-written one (its id kept). */
  renumbers: { stepId: string; title: string; from: number; to: number }[];
  /** THX-3b — an oven step retimed to the feast's one post-bird temperature. */
  minuteUpdates: { stepId: string; title: string; stepIndex: number; from: number; to: number }[];
  /** THX-3d (B) — a stock or water row a step measures and the dish never listed. */
  rowCreates: { dishId: string; title: string; ingredientId: string; canonicalName: string; quantity: number; unit: string; preparationNote: string | null; componentKey: string | null; pathKey: string | null; positionIndex: number; stepIndex: number }[];
}

let totalChanges = 0;
for (const t of feasts) {
  const meal = await prisma.meal.findFirst({
    where: { sourceType: "batch_generated", dishFamilyKey: t.key, isArchived: false },
    select: {
      id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: { dishId: true, positionIndex: true, roleLabel: true, dish: { select: { id: true, title: true, tags: true, estimatedTimeMinutes: true, dishIngredients: { orderBy: { positionIndex: "asc" }, select: { quantity: true, unit: true, ingredientId: true, preparationNote: true, positionIndex: true, ingredient: { select: { canonicalName: true } } } } } } },
      },
    },
  });
  if (!meal) { console.log(`\n▷ ${t.key}: not in this database — skipped`); continue; }
  const forks = await prisma.meal.count({ where: { sourceStoreMealId: meal.id } });
  const templateRefs = await prisma.mealPlanTemplateItem.count({ where: { mealId: meal.id } });
  const planRefs = await prisma.mealPlanItem.count({ where: { mealId: meal.id } });
  console.log(`\n▶ ${t.key} ${meal.id} "${meal.title.slice(0, 70)}" · plan items ${planRefs} · template items ${templateRefs} · user copies ${forks} (not patched)`);

  const plan: Plan = { tagUpdates: [], textUpdates: [], refUpdates: [], creates: [], minuteUpdates: [], renumbers: [], rowCreates: [], deletes: [], phaseUpdates: [] };
  const specOf = dishSpecFor(t);
  const stepsByDish = new Map<string, StepRow[]>();
  const storedStep = new Map<string, StepRow>();
  const matcherOf = new Map<string, MatcherIngredient[]>();
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
    // 14. THX-3d (C, rule 2) — a step that opens with prep and then does the dish's work
    // is two (feastCookWording splitPrepClause), so Cook Mode can say "Skip if you
    // prepped" to the prep alone: the prep is a new step at its index, the work keeps
    // the stored step (its id, phase, path) one down, the later steps move down too.
    // (Before 8: the work step it leaves must be named once, in this same run.)
    const cutRows = d.dishIngredients.map((i) => ({ id: i.ingredientId, name: i.ingredient.canonicalName, quantity: i.quantity, unit: i.unit, note: i.preparationNote }));
    // THX-3d — the text normalisations first, so a step split below is split from them:
    // "2 celery thirds stalks" (THX-3c's own naming) → "2 celery stalks (cut into thirds)";
    // (B) "both oranges" cannot scale, "2 oranges" can.
    for (const s of steps) texts.set(s.id, countsInWords(repairShapeCounts(texts.get(s.id)!), cutRows));
    const splitMinutes = new Map<string, number>();
    const titles = meal.dishLinks.map((l) => l.dish.title);
    for (const s of [...steps].sort((a, b) => b.stepIndex - a.stepIndex)) {
      const sp = splitPrepClause(texts.get(s.id)!, cutRows.map((r) => ({ ingredientId: r.id, name: r.name })), titles);
      if (!sp) continue;
      const at = s.stepIndex;
      for (const c of plan.creates) if (c.dishId === d.id && c.stepIndex >= at) c.stepIndex += 1;
      for (const o of [...steps].filter((o) => o.stepIndex >= at).sort((a, b) => b.stepIndex - a.stepIndex)) {
        plan.renumbers.push({ stepId: o.id, title: d.title, from: o.stepIndex, to: o.stepIndex + 1 });
        o.stepIndex += 1;
      }
      const prepMinutes = Math.max(1, Math.min(5, Math.round(s.estimatedMinutes / 2)));
      texts.set(s.id, sp.work);
      splitMinutes.set(s.id, Math.max(1, s.estimatedMinutes - prepMinutes));
      plan.creates.push({ dishId: d.id, title: d.title, stepIndex: at, text: sp.prep, phaseType: "prep", estimatedMinutes: prepMinutes, refs: null, componentKey: s.componentKey, pathKey: s.pathKey });
    }
    // 8. THX-3c (F) — a step that adds cut food names its amount ("add the 2 diced
    // onions and 6 diced celery stalks"), from the dish's own rows; a food the step
    // already measures (its stored refs) is left alone. Its refs are re-derived below.
    for (const s of steps) {
      // A split step measures what its work half measures (its stored refs were the whole step).
      const own = splitMinutes.has(s.id) ? deriveAmountRefs(texts.get(s.id)!, cutRows.map((r) => ({ ingredientId: r.id, name: r.name, quantity: r.quantity, unit: r.unit }))).amountRefs : s.amountRefs;
      const refIds = new Set(((Array.isArray(own) ? own : []) as { ingredientId?: string }[]).map((r) => r.ingredientId));
      const measured = new Set(cutRows.filter((r) => refIds.has(r.id)).map((r) => r.name));
      texts.set(s.id, nameCutAmounts(texts.get(s.id)!, cutRows, measured));
    }
    for (const s of steps) {
      const to = texts.get(s.id)!;
      if (to !== s.stepTextTranslated) plan.textUpdates.push({ stepId: s.id, title: d.title, stepIndex: s.stepIndex, from: s.stepTextTranslated, to });
    }
    // 12. THX-3d (B) — the stock and water a step measures and the dish never listed.
    const lastPos = Math.max(-1, ...d.dishIngredients.map((i) => i.positionIndex));
    const missing = missingRows(cutRows, steps.map((s) => ({ stepIndex: s.stepIndex, text: texts.get(s.id)!, componentKey: s.componentKey, pathKey: s.pathKey, amountRefs: s.amountRefs })));
    for (const [n, m] of missing.entries()) {
      const ingredient = await prisma.ingredient.findFirst({ where: { canonicalName: m.canonicalName }, select: { id: true } });
      if (!ingredient) { console.log(`  rows+ SKIPPED [${d.title}] no Ingredient named "${m.canonicalName}" in this database — the step #${m.stepIndex} amount stays unscaled`); continue; }
      plan.rowCreates.push({ dishId: d.id, title: d.title, ingredientId: ingredient.id, ...m, positionIndex: lastPos + 1 + n });
    }
    // 5. amountRefs, from the dish's own rows (mealMaterialize's matcher input)
    const matcher: MatcherIngredient[] = [
      ...d.dishIngredients.map((i) => ({ ingredientId: i.ingredientId, name: i.ingredient.canonicalName, quantity: i.quantity, unit: i.unit })),
      ...plan.rowCreates.filter((r) => r.dishId === d.id).map((r) => ({ ingredientId: r.ingredientId, name: r.canonicalName, quantity: r.quantity, unit: r.unit })),
    ];
    // ⚠️ ONLY where it must: a step whose text changed, or whose stored refs hold a
    // duration (BUG-450's "2 days"). Every other step keeps the refs it was written
    // with — re-deriving them from today's canonical names lost Vegetarian's
    // "1½ lb Honeycrisp apples" ref in the dry run (the generation-time names differ).
    // 🔴 THX-3d (B) — EVERY STEP NOW, merged: today's matcher (a mixed number's unit,
    // packages, brackets, ties) plus any stored ref it no longer makes on unchanged
    // text (thx2Rows mergeRefs) — never a corrupt "½ cups" or a "2 days".
    for (const s of steps) {
      const text = texts.get(s.id)!;
      const amountRefs = mergeRefs(text, deriveAmountRefs(text, matcher).amountRefs, text === s.stepTextTranslated ? s.amountRefs : null);
      // jsonb stores object keys in its own order, so compare key-sorted.
      if (canonical(amountRefs) !== canonical(s.amountRefs ?? null)) plan.refUpdates.push({ stepId: s.id, refs: amountRefs, was: s.amountRefs, text: texts.get(s.id)! });
    }
    for (const c of plan.creates) if (c.dishId === d.id && c.refs === null) c.refs = deriveAmountRefs(c.text, matcher).amountRefs;
    // 4. (THX-3d D) — no per-dish "On Thursday: Serve the …" step any more: the feast has
    // ONE serve step after the carve (thx2Thursday post-pass), naming every dish.
    // 13. THX-3d (F) — a thaw tag with no thaw step (Small's breast, thaw-2d): the Hub's
    // thaw row opened the whole dish. A code-written thaw step opens it; the rest move down.
    const thawTag = wantTags.map((x) => /^thaw-(\d+)d$/.exec(x)).find((m) => m);
    if (thawTag && !steps.some((s) => /^\s*Thaw \(/i.test(texts.get(s.id)!))) {
      const n = Number(thawTag[1]);
      const WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const word = /\bbreast\b/i.test(d.title) ? "turkey breast" : "turkey";
      const firstAhead = steps.map((s) => MAKE_AHEAD_DAY.exec(texts.get(s.id)!)?.[1]).find((x): x is string => !!x) ?? "Thursday";
      for (const s of [...steps].sort((a, b) => b.stepIndex - a.stepIndex)) {
        plan.renumbers.push({ stepId: s.id, title: d.title, from: s.stepIndex, to: s.stepIndex + 1 });
        s.stepIndex += 1;
      }
      for (const c of plan.creates) if (c.dishId === d.id) c.stepIndex += 1;
      const text = thawStepText(word, WEEK[(4 - n + 7) % 7], firstAhead);
      plan.creates.push({ dishId: d.id, title: d.title, stepIndex: 0, text, phaseType: "prep", estimatedMinutes: 2, refs: deriveAmountRefs(text, matcher).amountRefs });
    }
    stepsByDish.set(d.id, steps.map((s) => ({ ...s, stepTextTranslated: texts.get(s.id)!, estimatedMinutes: splitMinutes.get(s.id) ?? s.estimatedMinutes })));
    for (const s of steps) {
      const to = splitMinutes.get(s.id);
      if (to !== undefined && to !== s.estimatedMinutes) plan.minuteUpdates.push({ stepId: s.id, title: d.title, stepIndex: s.stepIndex, from: s.estimatedMinutes, to });
    }
    for (const s of steps) storedStep.set(s.id, s);
    matcherOf.set(d.id, matcher);
  }

  // 7. THX-3b (BUG-457) — one oven temperature after the bird.
  const ovenDishes = meal.dishLinks.map((l) => ({ dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex, roleLabel: l.roleLabel }));
  const ovenRows = (): OvenStepRow[] => meal.dishLinks.flatMap((l) => [
    ...(stepsByDish.get(l.dishId) ?? []).map((s) => ({ ...s, ownerId: l.dishId })),
    ...plan.creates.filter((c) => c.dishId === l.dishId).map((c) => ({ ownerId: l.dishId, stepIndex: c.stepIndex, stepTextTranslated: c.text, phaseType: c.phaseType, estimatedMinutes: c.estimatedMinutes, isTimingSensitive: false, parallelGroup: null, componentKey: c.componentKey ?? null, pathKey: c.pathKey ?? null })),
  ]);
  const titleOf = (dishId: string) => meal.dishLinks.find((l) => l.dishId === dishId)?.dish.title ?? "";
  /**
   * THX-3d (D) — a thx2Thursday edit batch onto the in-memory rows and the plan:
   * updates and deletes at the current indexes, then the moves, then the creates.
   */
  function applyEdits(e: ThursdayEdits): void {
    const rowAt = (dishId: string, idx: number) => stepsByDish.get(dishId)?.find((s) => s.stepIndex === idx);
    const createAt = (dishId: string, idx: number) => plan.creates.find((c) => c.dishId === dishId && c.stepIndex === idx);
    for (const u of e.updates) {
      const row = rowAt(u.dishId, u.stepIndex);
      if (row) {
        const stored = storedStep.get(row.id)!;
        if (u.text !== undefined && u.text !== row.stepTextTranslated) {
          const ex = plan.textUpdates.find((x) => x.stepId === row.id);
          if (ex) ex.to = u.text;
          else plan.textUpdates.push({ stepId: row.id, title: titleOf(u.dishId), stepIndex: stored.stepIndex, from: stored.stepTextTranslated, to: u.text });
          row.stepTextTranslated = u.text;
          plan.refUpdates = plan.refUpdates.filter((x) => x.stepId !== row.id);
          const refs = deriveAmountRefs(u.text, matcherOf.get(u.dishId) ?? []).amountRefs;
          if (canonical(refs) !== canonical(stored.amountRefs ?? null)) plan.refUpdates.push({ stepId: row.id, refs, was: stored.amountRefs, text: u.text });
        }
        if (u.minutes !== undefined && u.minutes !== row.estimatedMinutes) {
          plan.minuteUpdates = plan.minuteUpdates.filter((x) => x.stepId !== row.id);
          if (u.minutes !== stored.estimatedMinutes) plan.minuteUpdates.push({ stepId: row.id, title: titleOf(u.dishId), stepIndex: stored.stepIndex, from: stored.estimatedMinutes, to: u.minutes });
          row.estimatedMinutes = u.minutes;
        }
        if (u.phaseType !== undefined && u.phaseType !== row.phaseType) {
          plan.phaseUpdates = plan.phaseUpdates.filter((x) => x.stepId !== row.id);
          if (u.phaseType !== stored.phaseType) plan.phaseUpdates.push({ stepId: row.id, title: titleOf(u.dishId), stepIndex: stored.stepIndex, from: stored.phaseType, to: u.phaseType });
          row.phaseType = u.phaseType;
        }
        continue;
      }
      const c = createAt(u.dishId, u.stepIndex);
      if (!c) continue;
      if (u.text !== undefined) { c.text = u.text; c.refs = deriveAmountRefs(u.text, matcherOf.get(u.dishId) ?? []).amountRefs; }
      if (u.minutes !== undefined) c.estimatedMinutes = u.minutes;
      if (u.phaseType !== undefined) c.phaseType = u.phaseType as Plan["creates"][number]["phaseType"];
    }
    for (const x of e.deletes) {
      const rows = stepsByDish.get(x.dishId) ?? [];
      const row = rowAt(x.dishId, x.stepIndex);
      if (row) {
        plan.deletes.push({ stepId: row.id, title: titleOf(x.dishId), stepIndex: storedStep.get(row.id)!.stepIndex, text: row.stepTextTranslated });
        for (const k of ["textUpdates", "refUpdates", "minuteUpdates", "renumbers", "phaseUpdates"] as const) (plan[k] as { stepId: string }[]).splice(0, Infinity, ...(plan[k] as { stepId: string }[]).filter((y) => y.stepId !== row.id));
        stepsByDish.set(x.dishId, rows.filter((r) => r !== row));
        continue;
      }
      const c = createAt(x.dishId, x.stepIndex);
      if (c) plan.creates.splice(plan.creates.indexOf(c), 1);
    }
    for (const r of e.renumber) {
      const row = rowAt(r.dishId, r.from);
      if (row) {
        plan.renumbers.push({ stepId: row.id, title: titleOf(r.dishId), from: r.from, to: r.to });
        row.stepIndex = r.to;
        continue;
      }
      const c = createAt(r.dishId, r.from);
      if (c) c.stepIndex = r.to;
    }
    for (const c of e.creates) {
      plan.creates.push({ ...c, title: titleOf(c.dishId), phaseType: c.phaseType as Plan["creates"][number]["phaseType"], refs: deriveAmountRefs(c.text, matcherOf.get(c.dishId) ?? []).amountRefs });
    }
  }
  // THX-3d (D) — the Thursday pre-pass first: the sit, the rest, a side joining a
  // hotter bird, the side preheats where the raise heats the oven, the serve steps.
  applyEdits(thursdayPrePass(ovenDishes, ovenRows()));
  const ovenBefore = ovenReport(ovenDishes, ovenRows());
  const one = oneOvenTemperature(ovenBefore);
  for (const c of one.changes) {
    for (const [stepIndex, v] of retimeDish(ovenRows(), c)) {
      const row = stepsByDish.get(c.dishId)!.find((s) => s.stepIndex === stepIndex);
      if (!row) continue; // a code-written Thursday step is never an oven step
      const stored = storedStep.get(row.id)!;
      const existing = plan.textUpdates.find((u) => u.stepId === row.id);
      if (existing) existing.to = v.text;
      else plan.textUpdates.push({ stepId: row.id, title: c.title, stepIndex, from: stored.stepTextTranslated, to: v.text });
      if (v.minutes !== stored.estimatedMinutes) plan.minuteUpdates.push({ stepId: row.id, title: c.title, stepIndex, from: stored.estimatedMinutes, to: v.minutes });
      row.stepTextTranslated = v.text;
      row.estimatedMinutes = v.minutes;
      const { amountRefs } = deriveAmountRefs(v.text, matcherOf.get(c.dishId)!);
      plan.refUpdates = plan.refUpdates.filter((u) => u.stepId !== row.id);
      if (canonical(amountRefs) !== canonical(stored.amountRefs ?? null)) plan.refUpdates.push({ stepId: row.id, refs: amountRefs, was: stored.amountRefs, text: v.text });
    }
  }

  // 11. THX-3c (BUG-463) — a later oven block's preheat that also does work is split:
  // the preheat alone, then the work as its own prep step (thx2Oven splitPreheatSteps).
  for (const sp of splitPreheatSteps(ovenDishes, ovenRows())) {
    const rows = stepsByDish.get(sp.preheat.dishId)!;
    const pre = rows.find((x) => x.stepIndex === sp.preheat.stepIndex)!;
    for (const r of sp.renumber) {
      const row = rows.find((x) => x.stepIndex === r.from)!;
      plan.renumbers.push({ stepId: row.id, title: sp.work.title, from: r.from, to: r.to });
      row.stepIndex = r.to;
    }
    const stored = storedStep.get(pre.id)!;
    const existing = plan.textUpdates.find((u) => u.stepId === pre.id);
    if (existing) existing.to = sp.preheat.text;
    else plan.textUpdates.push({ stepId: pre.id, title: sp.work.title, stepIndex: pre.stepIndex, from: stored.stepTextTranslated, to: sp.preheat.text });
    pre.stepTextTranslated = sp.preheat.text;
    const matcher = matcherOf.get(sp.preheat.dishId) ?? [];
    plan.refUpdates = plan.refUpdates.filter((u) => u.stepId !== pre.id);
    const preRefs = deriveAmountRefs(sp.preheat.text, matcher).amountRefs;
    if (canonical(preRefs) !== canonical(stored.amountRefs ?? null)) plan.refUpdates.push({ stepId: pre.id, refs: preRefs, was: stored.amountRefs, text: sp.preheat.text });
    plan.creates.push({ ...sp.work, phaseType: "prep", refs: deriveAmountRefs(sp.work.text, matcher).amountRefs });
  }
  // 9. THX-3c (BUG-463) — a feast with no bird and two oven temperatures: each dish
  // that bakes first is covered with foil, then reheated uncovered at serving time
  // (thx2Oven heldDishSteps). Code-written, never AI.
  // THX-3d — right after the dish's last oven step, its later steps moved down.
  const held = heldDishSteps(ovenDishes, ovenRows());
  applyEdits({ updates: [], deletes: [], renumber: held.renumber, creates: held.creates.map(({ title: _title, ...c }) => c) });
  // 10. (THX-3d D) — THX-3c's "As the turkey comes out, raise the oven…" is replaced:
  // the post-pass writes ONE raise step while the bird roasts, and the serve step.
  applyEdits(thursdayPostPass(ovenDishes, ovenRows()));
  // THX-3d round 2 (O) — "while the oven heats for the next dish" only when it does.
  applyEdits({ updates: holdTextUpdates(ovenDishes, ovenRows()), deletes: [], renumber: [], creates: [] });

  for (const r of plan.rowCreates) console.log(`  rows+ [${r.title}] ${r.quantity} ${r.unit} ${r.canonicalName}${r.preparationNote ? ` (${r.preparationNote})` : ""} · ${r.componentKey ?? "—"}/${r.pathKey ?? "—"} — measured at step #${r.stepIndex}`);
  for (const u of plan.tagUpdates) console.log(`  tags  [${u.title}] ${u.from.join(" ") || "—"}  →  ${u.to.join(" ") || "—"}`);
  for (const u of plan.textUpdates) console.log(`  text  [${u.title} #${u.stepIndex}]\n          was: ${u.from}\n          now: ${u.to}`);
  for (const c of plan.creates) console.log(`  step+ [${c.title} #${c.stepIndex}] ${c.phaseType} ${c.estimatedMinutes}m: ${c.text}`);
  for (const u of plan.refUpdates) {
    const spans = (r: unknown) => ((Array.isArray(r) ? r : []) as { charStart: number; charEnd: number }[]).map((x) => `"${u.text.slice(x.charStart, x.charEnd)}"@${x.charStart}`).join(" ");
    console.log(`  refs  [${u.text.slice(0, 50)}…] ${spans(u.was) || "—"}  →  ${spans(u.refs) || "—"}`);
  }
  for (const u of plan.deletes) console.log(`  del   [${u.title} #${u.stepIndex}] ${u.text}`);
  for (const u of plan.phaseUpdates) console.log(`  phase [${u.title} #${u.stepIndex}] ${u.from} → ${u.to}`);
  for (const u of plan.renumbers) console.log(`  move  [${u.title}] #${u.from} → #${u.to}`);
  for (const u of plan.minuteUpdates) console.log(`  mins  [${u.title} #${u.stepIndex}] ${u.from} → ${u.to}`);
  // THX-3b (BUG-457) — the post-bird oven, every run: production's dry run proves the
  // feasts dev does not have.
  console.log(`  oven  Thursday, as stored${one.target !== null ? ` · after the bird: ${one.changes.length + one.refused.length ? `${one.target}°F for every side` : `one temperature (${one.target}°F)`}` : ""}`);
  for (const l of formatOvenReport(ovenBefore)) console.log(`  ${l}`);
  // THX-3c (BUG-462) — which bird each feast is written with, every run: a bird by
  // COUNT scales by whole birds (prepQuantity wholeBirdCount), one by weight by its
  // floor. Production's dry run answers this for Small and New Twist.
  for (const l of meal.dishLinks) {
    for (const i of l.dish.dishIngredients) {
      const name = i.ingredient.canonicalName;
      if (!/\b(turkey|chicken|duck|goose|hen)s?\b/i.test(name) || /\b(stock|broth|drippings|neck|giblets?)\b/i.test(name)) continue;
      const kind = isWholeBirdByWeight(i.unit, name) ? "whole bird by weight" : isWholeBirdByCount(i.unit, name) ? "whole bird by COUNT" : "not a whole bird";
      console.log(`  bird  [${l.dish.title}] ${i.quantity} ${i.unit} ${name} — ${kind}`);
    }
  }
  for (const r of one.refused) console.log(`  oven  REFUSED [${r.title}] ${r.from}°F → ${r.to}°F is more than ${25}°F: more than a time change — not patched, decide by hand`);
  if (one.changes.length > 0 || plan.creates.some((c) => c.phaseType !== "assemble" || /foil/.test(c.text)) || plan.renumbers.length > 0) {
    console.log(`  oven  Thursday, patched${one.changes.length ? ` (${one.changes.map((c) => `${c.title} ${c.from}°F → ${c.to}°F`).join("; ")})` : ""}`);
    for (const l of formatOvenReport(ovenReport(ovenDishes, ovenRows()))) console.log(`  ${l}`);
  }

  // 6. the times — stampMealTiming itself, over the PATCHED steps. Dry run: a tx that
  // answers reads from memory and captures the two writes instead of making them.
  const dishIds = meal.dishLinks.map((l) => l.dishId);
  const patchedSteps = dishIds.flatMap((id) => [
    ...(stepsByDish.get(id) ?? []).map((s) => ({ ...s, ownerId: id })),
    ...plan.creates.filter((c) => c.dishId === id).map((c) => ({ ownerId: id, stepIndex: c.stepIndex, estimatedMinutes: c.estimatedMinutes, phaseType: c.phaseType, isTimingSensitive: false, parallelGroup: null, componentKey: c.componentKey ?? null, pathKey: c.pathKey ?? null, stepTextTranslated: c.text })),
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

  const changes = plan.deletes.length + plan.phaseUpdates.length + plan.rowCreates.length + plan.tagUpdates.length + plan.textUpdates.length + plan.refUpdates.length + plan.creates.length + plan.minuteUpdates.length + plan.renumbers.length + (timeChanged ? 1 : 0);
  totalChanges += changes;
  if (!APPLY || changes === 0) continue;

  await prisma.$transaction(async (tx) => {
    for (const r of plan.rowCreates) {
      await tx.dishIngredient.create({ data: { dishId: r.dishId, ingredientId: r.ingredientId, quantity: r.quantity, unit: r.unit, preparationNote: r.preparationNote, positionIndex: r.positionIndex, componentKey: r.componentKey, pathKey: r.pathKey } });
    }
    for (const u of plan.tagUpdates) await tx.dish.update({ where: { id: u.dishId }, data: { tags: u.to } });
    for (const u of plan.textUpdates) await tx.recipeInstructionStep.update({ where: { id: u.stepId }, data: { stepTextRaw: u.to, stepTextTranslated: u.to } });
    for (const u of plan.refUpdates) await tx.recipeInstructionStep.update({ where: { id: u.stepId }, data: { amountRefs: u.refs as Prisma.InputJsonValue } });
    for (const u of plan.minuteUpdates) await tx.recipeInstructionStep.update({ where: { id: u.stepId }, data: { estimatedMinutes: u.to } });
    for (const u of plan.phaseUpdates) await tx.recipeInstructionStep.update({ where: { id: u.stepId }, data: { phaseType: u.to as StepPhase } });
    for (const u of plan.deletes) await tx.recipeInstructionStep.delete({ where: { id: u.stepId } });
    // Latest first, so two rows never share an index mid-move.
    // THX-3d — a step moved twice (the thaw step, then the raise step) goes straight to
    // its last index: one move per step.
    const finalIndex = new Map<string, { from: number; to: number }>();
    for (const u of plan.renumbers) finalIndex.set(u.stepId, { from: finalIndex.get(u.stepId)?.from ?? u.from, to: u.to });
    for (const [stepId, u] of [...finalIndex].sort((a, b) => b[1].from - a[1].from)) await tx.recipeInstructionStep.update({ where: { id: stepId }, data: { stepIndex: u.to } });
    for (const c of plan.creates) {
      await tx.recipeInstructionStep.create({
        data: { ownerType: "dish", ownerId: c.dishId, stepIndex: c.stepIndex, stepTextRaw: c.text, stepTextTranslated: c.text, phaseType: c.phaseType, estimatedMinutes: c.estimatedMinutes, isTimingSensitive: false, amountRefs: c.refs as Prisma.InputJsonValue, componentKey: c.componentKey ?? null, pathKey: c.pathKey ?? null },
      });
    }
    await stampMealTiming(tx, meal.id, dishIds);
  }, { timeout: 60_000 });
  console.log(`  ✅ applied`);
}

console.log(`\n${APPLY ? "applied" : "would apply"} ${totalChanges} change(s) across ${feasts.length} feast target(s)${APPLY ? "" : " — re-run with --apply"}`);
await prisma.$disconnect();
