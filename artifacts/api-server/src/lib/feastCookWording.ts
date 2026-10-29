// THX-3d (C, R2) — PREP FEEDS COOK: A FEAST DISH'S COOK STEPS, WORDED AT READ TIME.
//
// Hans, October 21: in Prep the feast he zested and juiced the orange, rinsed the
// cranberries and measured the cranberry mix, marked them done — and Monday's Cook Mode
// opened with "zest and juice the orange, set aside", then "combine 9⅝ oz rinsed
// cranberries, 1½ cups sugar, the orange juice and zest, ¼ cup water, 1 cinnamon stick
// and a pinch of salt". He asked for the most reliable shape, one that holds when a user
// swaps or adds a dish: "I'm also totally fine to have the steps in cook mode for the
// feast meals 'skip if you prepped. otherwise, zest and juice 3/4 orange and set aside'."
//
// So the words are produced HERE, when the meal is read in its plan, from the feast's
// own Prep the feast build (deterministic, no AI) — never written into the recipe, so a
// dish added to the feast is worded the same way, and nothing depends on a tick:
//
//   1. a step whose whole job Prep the feast did — every food it names was cut or
//      measured there, the way the step cuts it — opens "Skip if you prepped. Otherwise,";
//   3. at the step a mix enters (the first that states two of its members — the
//      closing line's rule), the members listed there name the MIX instead ("the
//      Cranberry-Orange Sauce dry mix"): the first becomes the mix, the others leave;
//   4. prepped produce is named by its container — only when one list in the step
//      names everything the dish's container holds ("the Pan Gravy vegetables you
//      prepped", "the yellow onion and celery you prepped"); a shared tub's food by the
//      tub, when the step cuts it that way ("the minced garlic you prepped"). A plate's
//      piles stay as written.
// (2, the split of a step that mixes prep and the rest, is content: patch.ts.)
//
// Only what a step MEASURES is touched — a food with an amount, or one in a list beside
// one — and only within one list: "until the cranberries burst", "dissolve the sugar"
// and a member in another clause stay as they are. Every surviving amountRef moves with
// its text; one in a removed item goes with it.

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { buildCoreWeek, buildFeastSession, isTickable, tickableStepRefs, type PrepWeekBuild } from "./prepWeekBuild";
import { cachedStepsOf, resolveTicks } from "./prepTickCarry";
import { ingredientGroupKey } from "./ingredientRelations";
import { FEAST_MEAL_TAG, loadPrepWeekInput } from "./prepWeekAggregation";
import { dishScalesOf, scaleFrames } from "./feastScaleFrames";
import type { FeastLabelKind } from "./prepFeastLabels";
import { shortDish } from "./prepWeekLabels";
import { spokenAmount } from "./prepWeekAssembly";
import { displayedPrepQuantity } from "./prepQuantity";
import { logger } from "./logger";
import { planMealsOf, splitTicks, ticksForMeal } from "./prepScope";

/** A reworded step's words, refs and (round 5, D-WS9-321) the prepped containers it uses. */
export interface CookWording { text: string; amountRefs: WordingRef[] | null; preppedRefs?: PreppedRef[] }

/**
 * GET /meals/:id?planItemId= — a feast meal read in its plan: each dish's steps
 * worded from that plan's Prep the feast. Returns the new text and refs by dish id
 * and step index (only the steps that change); empty for any other meal. The caller
 * must already have scoped the plan to the user (the plan item read does).
 */
export async function feastCookWordingFor(
  prisma: PrismaClient,
  args: { planId: string; userId: string; mealTags: readonly string[]; dishes: readonly { dishId: string; title: string; steps: readonly { stepIndex: number; text: string; amountRefs?: unknown }[] }[]; now?: Date },
): Promise<Map<string, Map<number, CookWording>>> {
  const out = new Map<string, Map<number, CookWording>>();
  if (!args.mealTags.includes(FEAST_MEAL_TAG) || args.dishes.length === 0) return out;
  const load = await loadPrepWeekInput({ planId: args.planId, userId: args.userId, prisma, ...(args.now ? { now: args.now } : {}) });
  const build = buildFeastSession(load);
  if (!build) return out;
  const facts = feastDishFacts(build);
  // Round 2 (O) — the counts this plan shows as one, and its servings, per dish.
  const scales = dishScalesOf(load);
  const rows = await prisma.dishIngredient.findMany({
    where: { dishId: { in: args.dishes.map((d) => d.dishId) } },
    select: { dishId: true, ingredientId: true, ingredient: { select: { canonicalName: true } } },
  });
  const titles = args.dishes.map((d) => d.title);
  for (const d of args.dishes) {
    const before = d.steps.map((s) => ({ stepIndex: s.stepIndex, text: s.text, amountRefs: Array.isArray(s.amountRefs) ? (s.amountRefs as WordingRef[]) : null }));
    const after = rewordFeastSteps(before, rows.filter((r) => r.dishId === d.dishId).map((r) => ({ ingredientId: r.ingredientId, name: r.ingredient.canonicalName })), facts.get(d.dishId), titles)
      .map((s) => scaleFrames(s, scales.get(d.dishId)));
    after.forEach((a, i) => {
      if (a.text === before[i].text) return;
      if (!out.has(d.dishId)) out.set(d.dishId, new Map());
      out.get(d.dishId)!.set(a.stepIndex, { text: a.text, amountRefs: a.amountRefs, ...(a.preppedRefs?.length ? { preppedRefs: a.preppedRefs } : {}) });
    });
  }
  return out;
}

/**
 * SERVER-7 B — the steps of today's build a weeknight's ticks count as done: resolved
 * against the cached week the cook ticked (prepTickCarry), carrying only a step the cook
 * can tick today.
 */
export function weeknightDoneSteps(build: PrepWeekBuild, ticks: Iterable<string>, structureJson: unknown, fold: (id: string) => string): Set<string> {
  return resolveTicks(ticks, build.stepPlan.steps, { cached: cachedStepsOf(structureJson), fold, carryable: (s) => isTickable(s, build) }).done;
}

/**
 * PREP-3 (R1) — GET /meals/:id?planItemId= for a weeknight meal: each dish's steps worded
 * from that plan's Prep the Week, from the steps the cook TICKED only. Prep the Week is
 * optional (and premium): a week nobody prepped must never say "the Skewers marinade".
 * `prepped` (the meal GET's `?prepped=1`, Cook Mode's "yes, I prepped" answered without
 * ticks) takes every step the cook could tick as ticked. Empty for a feast (its words
 * are feastCookWordingFor's) and for a plan with nothing ticked.
 */
export async function weeknightCookWordingFor(
  prisma: PrismaClient,
  args: {
    planId: string;
    userId: string;
    /** SERVER-9 C (BUG-582) — the meal being read: a subset session's tick counts only for its meals. Absent, only the week's ticks count. */
    mealId?: string;
    mealTags: readonly string[];
    prepped?: boolean;
    dishes: readonly { dishId: string; title: string; steps: readonly { stepIndex: number; text: string; amountRefs?: unknown }[] }[];
    now?: Date;
  },
  /** SERVER-9 C — the loader, injectable so a test can hand in a two-meal week. */
  deps: { loadPrepWeekInput?: typeof loadPrepWeekInput } = {},
): Promise<Map<string, Map<number, CookWording>>> {
  const out = new Map<string, Map<number, CookWording>>();
  if (args.mealTags.includes(FEAST_MEAL_TAG) || args.dishes.length === 0) return out;
  const stored = args.prepped
    ? null
    : (await prisma.prepStepCompletion.findMany({ where: { planId: args.planId }, select: { stepKey: true } })).map((r) => r.stepKey);
  if (stored && stored.length === 0) return out;
  const load = await (deps.loadPrepWeekInput ?? loadPrepWeekInput)({ planId: args.planId, userId: args.userId, prisma, ...(args.now ? { now: args.now } : {}) });
  // 🔴 SERVER-9 C (BUG-582) — the ticks FOR THIS MEAL: the week's, and a subset or
  // one-meal session's only when that session held this meal (lib/prepScope).
  const planMeals = planMealsOf(load);
  const ticked = stored
    ? new Set(args.mealId ? ticksForMeal(stored, args.mealId, planMeals) : splitTicks(stored, planMeals).unscoped)
    : null;
  if (ticked && ticked.size === 0) return out;
  const build = buildCoreWeek(load);
  // 🔴 SERVER-7 B (BUG-556/557) — the ticks are keys of the structure the cook TICKED: the
  // plan's cached Prep the Week, which an engine change re-keys. They are resolved against
  // it (prepTickCarry): a step today counts when its key was ticked, or when every
  // portion of it that screen showed was ticked there.
  const cache = ticked ? await prisma.prepWeekStructure.findUnique({ where: { planId: args.planId }, select: { structureJson: true } }) : null;
  const done = ticked
    ? weeknightDoneSteps(build, ticked, cache?.structureJson, (id) => load.identity?.foldedIdByIngredientId.get(id) ?? id)
    : new Set(tickableStepRefs(build).map((r) => r.stepKey));
  const facts = feastDishFacts(build, { onlySteps: done, weeknight: true });
  // PREP-3 3b — the amount the cook sees (Cook Mode scales each ref by its row): "(1 clove)".
  const scales = dishScalesOf(load);
  // The steps Cook Mode collapses (cookSession doneInPrepStepKeys): every prep step that
  // covers one is done.
  const coveringBy = new Map<string, string[]>();
  for (const st of build.stepPlan.steps) {
    for (const c of st.coversCookSteps ?? []) {
      const k = `${c.dishId}|${c.stepIndex}`;
      coveringBy.set(k, [...(coveringBy.get(k) ?? []), st.stepKey]);
    }
  }
  for (const [k, keys] of coveringBy) {
    if (!keys.every((x) => done.has(x))) continue;
    const [dishId, index] = k.split("|");
    const f = facts.get(dishId) ?? { dishId, mixes: [], cuts: [] };
    facts.set(dishId, { ...f, covered: new Set([...(f.covered ?? []), Number(index)]) });
  }
  const rows = await prisma.dishIngredient.findMany({
    where: { dishId: { in: args.dishes.map((d) => d.dishId) } },
    select: { dishId: true, ingredientId: true, ingredient: { select: { canonicalName: true } } },
  });
  const titles = args.dishes.map((d) => d.title);
  for (const d of args.dishes) {
    const before = d.steps.map((s) => ({ stepIndex: s.stepIndex, text: s.text, amountRefs: Array.isArray(s.amountRefs) ? (s.amountRefs as WordingRef[]) : null }));
    const scale = scales.get(d.dishId);
    const countOf = (r: WordingRef) => r.quantity * (scale?.rows.get(r.ingredientId)?.mult ?? (scale ? scale.servings / scale.authoredServings : 1));
    const after = rewordFeastSteps(before, rows.filter((r) => r.dishId === d.dishId).map((r) => ({ ingredientId: r.ingredientId, name: r.ingredient.canonicalName })), facts.get(d.dishId), titles, { weeknight: true, countOf });
    after.forEach((a, i) => {
      if (a.text === before[i].text) return;
      if (!out.has(d.dishId)) out.set(d.dishId, new Map());
      out.get(d.dishId)!.set(a.stepIndex, { text: a.text, amountRefs: a.amountRefs, ...(a.preppedRefs?.length ? { preppedRefs: a.preppedRefs } : {}) });
    });
  }
  return out;
}

export interface WordingRef { ingredientId: string; quantity: number; unit: string; charStart: number; charEnd: number }
/**
 * THX-3d round 5 (D-WS9-321) — a prepped container a reworded Cook Mode step uses: Prep's
 * own id for it (opaque to the client) and its label as Prep shows it ("Taco spices").
 * Cook Mode draws "You prepped this · <label>" from it (CLIENT-2b's chip).
 */
export interface PreppedRef { containerId: string; label: string }
export const PreppedRefSchema = z.object({ containerId: z.string().min(1).max(200), label: z.string().min(1).max(120) });
/** On the wire: absent when a step uses nothing prepped, never empty. */
export const PreppedRefsSchema = z.array(PreppedRefSchema).min(1);
export interface WordingStep { stepIndex: number; text: string; amountRefs: WordingRef[] | null; preppedRefs?: PreppedRef[] }
export interface WordingRow { ingredientId: string; name: string }

export interface FeastDishFacts {
  dishId: string;
  /** The mixes and jars Prep the feast fills for this dish (members by id and by food). */
  mixes: { name: string; ids: Set<string>; keys: Set<string>; /** Round 2 (L) — what the mix holds of each food, by food key. */ amounts?: Map<string, { qty: number; unit: string }>; /** Round 5 — Prep's container id. */ containerId?: string }[];
  /** Produce cut ahead for this dish: the food, the container it went into, its cut words. */
  cuts: { id: string; key: string; into: string | null; note: string; kind?: FeastLabelKind | null; /** PREP-3 3b — a week's: what the container holds of it for this dish ("4 cups"). */ amount?: string; /** Round 5 — Prep's name for the container (its id). */ containerId?: string }[];
  /**
   * PREP-3 3b — a week's: the proteins cut in Proteins for this dish ("cut into 1½-inch
   * chunks"), each in its own package. Read only where a step would cut it again.
   */
  proteins?: { id: string; key: string; into: string | null; note: string; amount?: string; /** Round 5 — the package's id. */ containerId?: string }[];
  /**
   * PREP-3 (R1) — a week's: the dish's steps Cook Mode collapses as done in prep (every
   * prep step covering it ticked). Their words are left as they are.
   */
  covered?: ReadonlySet<number>;
}

/**
 * The per-dish facts of a feast session build (its kept steps; a portion held for cook day is not prepped).
 * PREP-3 (R1) — and of a week's: only the steps the cook ticked (`onlySteps`), each
 * container said by the week's label ("Skewers marinade", "Minced garlic").
 */
export function feastDishFacts(build: PrepWeekBuild, opts: { onlySteps?: ReadonlySet<string>; weeknight?: boolean } = {}): Map<string, FeastDishFacts> {
  const out = new Map<string, FeastDishFacts>();
  const of = (dishId: string) => {
    let f = out.get(dishId);
    if (!f) out.set(dishId, (f = { dishId, mixes: [], cuts: [] }));
    return f;
  };
  const label = (n: string) => build.weekLabels?.map.get(n) ?? n;
  const kindOf = (n: string): FeastLabelKind | null => build.stepPlan.feastLabels?.kinds.get(n) ?? build.weekLabels?.labels.kinds.get(label(n)) ?? null;
  // SERVER-7 B (QA-6) — ONE ID PER CONTAINER, whatever was ticked. A mix's id is its
  // container step's; a cut that went into that mix said the engine's destination name, so
  // with the mix's own steps unticked "Skewers marinade" came with another id. The cut
  // takes the mix's id, read from every step of the build, never only the ticked ones.
  const mixIdOf = new Map<string, string>();
  for (const st of build.stepPlan.steps) {
    if (st.demoted || !st.bowlName || (st.phase !== "seasonings_dry" && st.phase !== "sauces_marinades") || mixIdOf.has(st.bowlName)) continue;
    mixIdOf.set(st.bowlName, st.containerId ?? st.bowlName);
  }
  for (const st of build.stepPlan.steps) {
    if (st.demoted) continue;
    if (opts.onlySteps && !opts.onlySteps.has(st.stepKey)) continue;
    const hold = build.holds.get(st.stepKey);
    if (hold?.all) continue;
    const components = hold ? hold.keptComponents : st.components;
    if ((st.phase === "seasonings_dry" || st.phase === "sauces_marinades") && st.bowlName) {
      // A mix filled over two steps (dry, then wet) is prepped once both are ticked.
      const filledBy = build.stepPlan.steps.filter((s) => s.bowlName === st.bowlName && !s.demoted).map((s) => s.stepKey);
      if (opts.onlySteps && !filledBy.every((k) => opts.onlySteps!.has(k))) continue;
      for (const c of components) {
        for (const m of c.measures) {
          if (!m.dishId) continue;
          const f = of(m.dishId);
          const name = label(st.bowlName);
          let mix = f.mixes.find((x) => x.name === name);
          if (!mix) f.mixes.push((mix = { name, ids: new Set(), keys: new Set(), amounts: new Map(), containerId: st.containerId ?? st.bowlName }));
          if (m.ingredientId) mix.ids.add(m.ingredientId);
          mix.keys.add(ingredientGroupKey(c.ingredientName));
          if (m.qty !== undefined && m.unit !== undefined) {
            const k = ingredientGroupKey(c.ingredientName);
            const have = mix.amounts!.get(k);
            mix.amounts!.set(k, have && have.unit === m.unit ? { qty: have.qty + m.qty, unit: m.unit } : have ?? { qty: m.qty, unit: m.unit });
          }
        }
      }
    }
    if (st.phase === "produce") {
      for (const c of components) {
        for (const m of c.measures) {
          if (!m.dishId) continue;
          // Round 2 (N) — the container's label and what it is (prepFeastLabels).
          // PREP-3 (R1) — a juice row's name says its cut ("fresh lemon juice", freshly squeezed).
          const juice = /\bjuice\b/i.test(c.ingredientName) ? " juice" : "";
          of(m.dishId).cuts.push({ id: m.ingredientId ?? "", key: ingredientGroupKey(c.ingredientName), into: m.destination ? label(m.destination) : null, note: `${m.preparationNote ?? ""} ${c.preparationNote ?? ""}${juice}`.toLowerCase(), kind: m.destination ? kindOf(m.destination) : null, ...(opts.weeknight ? { amount: spokenAmount(m.amount) } : {}), ...(m.destination ? { containerId: mixIdOf.get(m.destination) ?? m.destination } : {}) });
        }
      }
    }
    if (opts.weeknight && st.phase === "proteins" && !st.bowlName && !st.cookDaySentence) {
      for (const c of components) {
        for (const m of c.measures) {
          if (!m.dishId) continue;
          const f = of(m.dishId);
          (f.proteins ??= []).push({ id: m.ingredientId ?? "", key: ingredientGroupKey(c.ingredientName), into: (m.mealId ? build.weekLabels?.proteins.get(st.stepKey)?.get(m.mealId) : undefined) ?? null, note: `${m.preparationNote ?? ""} ${c.preparationNote ?? ""}`.toLowerCase(), amount: spokenAmount(m.amount), containerId: m.mealId ? `${st.stepKey}#${m.mealId}` : st.stepKey });
        }
      }
    }
  }
  return out;
}

const DAY_PREFIX = /^(\s*(?:Make ahead \([A-Za-z]+(?: night)?\)|On [A-Za-z]+day|Thaw \(start [A-Za-z]+\))\s*:\s*)/i;
/** The code-written raise and serve steps name dishes, not foods: never reworded. */
const CODE_WRITTEN = /^\s*(?:Raise the oven to \d{3}\s*°\s*F and put in|Put the .+ in the oven with the |Serve the .+ with the )/i;
/** The words a step whose whole job is prep may use besides its foods. */
const PREP_WORD = /^(?:and|the|then|of|from|a|an|into|in|to|small|large|medium|bowl|set|aside|finely|thinly|roughly|coarsely|lightly|leaves?|stems?|zest|juice|peel|core|slice|sliced|dice|diced|mince|minced|chop|chopped|cut|trim|trimmed|halve|halved|quarter|quartered|grate|grated|pick|picked|strip|stripped|smash|smashed|rinse|rinsed|over|measure|mix|whisk|combine|stir|together|discarding|any|soft|shriveled|bad|ones|seeds?|leave|leaving|some|for|more|heat|inch|chunks|pieces|rings|separate|separated|separately|apart|keep|keeping|whites|greens|reserve|reserving|both|each|all|your|it|them|out|on|board|sprigs?|cloves?|stalks?|tablespoons?|teaspoons?|tbsp|tsp|cups?|oz|ounces?|lbs?|pounds?|pinch|seed|seeded|thick|wedges|cubes|slices|bite|sized|florets|strips|half|moons|rounds|can|jar|fine|paste|thin|against|grain|removing|less|or)$/i;
/** Only foods and prep words in the text once the mentions are cut out. */
const onlyPrepWords = (text: string, ms: readonly Mention[], from = 0) =>
  ms.reduceRight((t, m) => t.slice(0, m.start) + " " + t.slice(m.end), text).slice(from)
    .split(/[\s,;:.()–\-/]+/).filter(Boolean).every((w) => PREP_WORD.test(w) || /^[\d½¼¾⅓⅔⅛⅜⅝⅞×x]+$/.test(w));
/** The cut words a step may ask of a food (each must be among the prepped cut's words). */
const CUT_WORDS = ["zest", "juice", "mince", "dice", "chop", "slice", "halve", "quarter", "smash", "grate", "trim", "peel", "rinse", "pick", "strip", "cube"];
const CITRUS = /\b(lemons?|limes?|oranges?|grapefruits?)$/i;
/** After a food's head word: the plural noun it is counted in, and a citrus's parts. */
const TRAILING = /^(?:\s+(?:cloves?|stalks?|sprigs?|leaves|pieces|halves|ribs?|bunch(?:es)?|pods?|whites|greens))?(?:\s+(?:juice|zest)(?:\s+and\s+(?:juice|zest))?)?/i;
/**
 * Before a food: an article, "a pinch of", "the juice of", and up to four cut words or adjectives.
 * (PREP-3 R1 — "the squeezed cucumber" is one food: the group had printed "the squeezed the cucumber, …".)
 */
const LEADING = /(?:\b(?:the|a|an)\s+(?:pinch\s+of\s+)?|\ba\s+pinch\s+of\s+|\b(?:the\s+)?(?:zest|juice)(?:\s+and\s+(?:zest|juice))?\s+of\s+(?:the\s+)?)?(?:(?:zest(?:ed)?|juice(?:d)?|and|minced|smashed|diced|finely|thinly|roughly|coarsely|chopped|sliced|quartered|halved|trimmed|peeled|rinsed|picked|grated|stripped|squeezed|drained|shredded|crumbled|crushed|toasted|fresh|whole|large|small|medium|cold|softened|packed|light|dark|ground|kosher|granulated)\s+){0,4}$/i;
/** Words of a food's name that do not tell two rows apart. */
const GENERIC_WORD = /^(?:fresh|whole|large|small|medium|light|dark|packed|ground|kosher|granulated|all-purpose|unsalted|salted|cold|low-sodium|extra-virgin|pure|sea|flaky|dried|frozen|canned|store-bought|or)$/i;
const FORM_WORD = /^(?:halves|leaves|stalks|cloves|sprigs|sticks?|pieces|florets|heads|bulbs|slices)$/i;
const SEPARATOR_BEFORE = /(?:,\s+(?:and\s+)?|\s+and\s+)$/;
const SEPARATOR_AFTER = /^(?:,\s+(?:and\s+)?|\s+and\s+)/;
const CLAUSE_END = /[;:.]/;

export interface Mention { id: string; key: string; name: string; start: number; end: number; ref: boolean; cut: string[] }

const singular = (w: string) => w.toLowerCase().replace(/(?:(?<=[sxz]|ch|sh|o)es|s)$/, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The dish's foods a step names, with where (dish titles masked out). */
export function mentionsOf(step: WordingStep, rows: readonly WordingRow[], titles: readonly string[]): Mention[] {
  let masked = step.text;
  for (const t of titles) if (t) masked = masked.split(t).join(" ".repeat(t.length));
  const lower = masked.toLowerCase();
  const out: Mention[] = [];
  const refs = step.amountRefs ?? [];
  // The longer name first: "packed light brown sugar" claims its words before "granulated sugar" can.
  // Round 2 (L) — then the more TELLING words first: "brown sugar" claims "packed brown
  // sugar" before "granulated sugar" (granulated tells nothing) takes its "sugar".
  const telling = (r: WordingRow) => r.name.split(/[,(]/)[0].trim().split(/\s+/).filter((w) => !GENERIC_WORD.test(w)).length;
  const byLength = [...rows].sort((a, b) => b.name.split(/[,(]/)[0].trim().split(/\s+/).length - a.name.split(/[,(]/)[0].trim().split(/\s+/).length || telling(b) - telling(a));
  for (const row of byLength) {
    const named = row.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).filter(Boolean);
    // "pecan halves", "sage leaves": the food is also the word before its form.
    // ("ground cloves" is the food itself.)
    const forms = FORM_WORD.test(named[named.length - 1] ?? "") && named.length >= 2 && !GENERIC_WORD.test(named[named.length - 2]) ? [named, named.slice(0, -1)] : [named];
    // Round 2 (L) — "cayenne pepper" is written "a pinch of cayenne".
    if (named.length === 2 && named[1] === "pepper" && /^(?:cayenne|chipotle|aleppo|ancho)$/.test(named[0])) forms.push([named[0]]);
    // (Then its head alone is never this row: "pepper" is not the cayenne, "halves" not the pecans.)
    const formed = forms.length > 1;
    // PREP-3 3b — "romaine lettuce" is written "the romaine" (and "the lettuce" stays its own).
    if (named.length >= 2 && named[named.length - 1] === "lettuce" && !GENERIC_WORD.test(named[named.length - 2])) forms.push(named.slice(0, -1));
    for (const words of forms) {
    const head = singular(words[words.length - 1] ?? "");
    if (head.length < 3) continue;
    // The words that tell this row from another of the same head ("brown" of brown sugar).
    // (Only asked when another row shares the head: "old-fashioned" rolled oats is written "rolled oats".)
    const shared = rows.some((o) => o !== row && singular(o.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop() ?? "") === head);
    const telling = shared ? words.slice(0, -1).filter((w) => !GENERIC_WORD.test(w)).map(singular) : [];
    for (const m of lower.matchAll(new RegExp(`\\b${escape(head)}(?:e?s)?\\b`, "gi"))) {
      let start = m.index!;
      let end = start + m[0].length;
      const before = lower.slice(Math.max(0, start - 40), start);
      // (PREP-3 — in its own list item: "3 tablespoons soy sauce, 2 tablespoons hoisin sauce"
      // had given the hoisin to the soy sauce.)
      const item = before.split(/[,;:.]|\band\b/).pop() ?? before;
      if (telling.some((w) => !new RegExp(`\\b${escape(w)}`).test(item))) continue;
      // A form ("leaves", "stick") is this row's only right after its food ("thyme leaves" is not sage).
      if (formed && words === named &&!new RegExp(`\\b${escape(words[words.length - 2])}\\s+$`).test(before)) continue;
      end += TRAILING.exec(step.text.slice(end))?.[0].length ?? 0;
      // Round 2 (L) — a compound is another thing: "the garlic butter" is not the garlic.
      if (/^\s+(?:butter|oil|salt|powder|paste|mixture|bread)\b/i.test(step.text.slice(end))) continue;
      // …and where it came from is the food's too: "leaves from 4 sprigs", "zest from 1 lemon".
      end += /^\s+from\s+(?:the\s+)?(?:[\d½¼¾⅓⅔]+\s+)?(?:\w+\s+){0,2}(?:sprigs?|lemons?|limes?|oranges?|bunch(?:es)?)\b/i.exec(step.text.slice(end))?.[0].length ?? 0;
      // Round 3 (U) — so is its cut (", cut into thirds,"): the prep did it.
      end += /^(?:\s*\(cut into [^)]{1,30}\)|,\s*cut into [a-z0-9 -]{1,30}?,)/i.exec(step.text.slice(end))?.[0].length ?? 0;
      // "(optional)" is the food's: it leaves with it when the food joins a mix.
      end += /^\s*\((?:optional|if using)\)/i.exec(step.text.slice(end))?.[0].length ?? 0;
      // The row's own words before its head ("cinnamon" stick, "cremini" mushrooms).
      for (const w of words.slice(0, -1).reverse()) {
        const own = new RegExp(`\\b${escape(w)}\\s+$`, "i").exec(step.text.slice(Math.max(0, start - w.length - 3), start));
        if (own) start -= own[0].length;
      }
      const lead = LEADING.exec(step.text.slice(Math.max(0, start - 60), start));
      // (PREP-3 — a list's "and" is the list's, never the food's: "…olives, and red onion"
      // had printed "the and red onion you prepped".)
      if (lead) start -= lead[0].replace(/^and\s+/i, "").length;
      // An amount right before it is its amount, whichever row the matcher bound it to.
      const ref = refs.find((r) => r.charEnd <= start && /^\s*$/.test(step.text.slice(r.charEnd, start)) && start - r.charEnd <= 2);
      if (ref) start = ref.charStart;
      const partOf = /\b(?:the\s+)?(?:juice|zest)(?:\s+and\s+(?:juice|zest))?\s+of\s+$/i.exec(step.text.slice(Math.max(0, start - 30), start));
      if (partOf) start -= partOf[0].length;
      const leadThe = /\bthe\s+$/i.exec(step.text.slice(Math.max(0, start - 4), start));
      if (leadThe) start -= leadThe[0].length;
      if (out.some((o) => o.start < end && start < o.end)) continue;
      const span = step.text.slice(start, end).toLowerCase();
      out.push({ id: row.ingredientId, key: ingredientGroupKey(row.name), name: row.name, start, end, ref: !!ref || refs.some((r) => r.charStart >= start && r.charEnd <= end), cut: CUT_WORDS.filter((c) => span.includes(c)) });
    }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Two mentions are in one list: only separators (and list items with no clause end) between them. */
export function listed(text: string, a: Mention, b: Mention): boolean {
  const [x, y] = a.start < b.start ? [a, b] : [b, a];
  const gap = text.slice(x.end, y.start);
  if (CLAUSE_END.test(gap)) return false;
  return /^(?:,\s+(?:and\s+)?|\s+and\s+)(?:[^,]{0,40}(?:,\s+(?:and\s+)?|\s+and\s+))*$/.test(gap);
}

/** Measured: a food with an amount, or one in a list beside one. */
export function measured(text: string, ms: readonly Mention[]): Mention[] {
  const keep = new Set<Mention>(ms.filter((m) => m.ref));
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < ms.length; i++) {
      if (keep.has(ms[i])) continue;
      if ([ms[i - 1], ms[i + 1]].some((o) => o && keep.has(o) && listed(text, ms[i], o))) { keep.add(ms[i]); grew = true; }
    }
  }
  return ms.filter((m) => keep.has(m));
}

/** The phrase prepped produce goes by: the dish's own container ("whole"), or a shared tub's food. */
export function cutPhrase(into: string, titles: readonly string[] = [], kind?: FeastLabelKind | null): { phrase: string; whole: boolean } | null {
  // Round 2 (N) — a labelled container is said by its label: "the Gravy vegetables you
  // prepped", "the minced garlic you prepped"; a plate's piles stay as written.
  if (kind === "own" || kind === "mix") return { phrase: `the ${into} you prepped`, whole: true };
  if (kind === "shared") return { phrase: `the ${into.toLowerCase()} you prepped`, whole: false };
  if (kind === "plate") return null;
  const clean = into.replace(/\s*\([^)]*\)/g, "");
  const dash = /^(.+?) — (.+)$/.exec(clean);
  if (dash) {
    // "<dish> — its members" is the dish's own container; "<food> — <dishes>" a shared tub.
    if (titles.some((t) => t === dash[1])) return { phrase: `the ${dash[2]} you prepped`, whole: true };
    // A citrus tub by what is in it: "the lemon juice you prepped", not "the juiced lemon".
    const food = dash[1].toLowerCase()
      .replace(/^(?:zested and juiced|zested, then juiced) (.+)$/, "$1 zest and juice")
      .replace(/^juiced (.+)$/, "$1 juice")
      .replace(/^zested (.+)$/, "$1 zest");
    return { phrase: `the ${food} you prepped`, whole: false };
  }
  if (/ citrus jar$/i.test(clean)) return { phrase: `the ${clean}`, whole: true };
  const veg = /^(.+?) (vegetables|aromatics)$/i.exec(clean);
  if (veg) return { phrase: `the ${veg[1]} ${veg[2]} you prepped`, whole: true };
  return null; // a prep plate or a toppings plate: separate piles, named as written
}

const CUT_LEAD = /^(?:zest|juice|trim|peel|core|mince|chop|dice|slice|measure|rinse|halve|quarter|grate|seed|pick|strip|smash|finely|thinly|roughly|coarsely)\b/i;
/** PREP-3 (R1) — where one clause of a step ends and the next begins: a verb starts it. */
const CLAUSE_SEP = /;\s+|\.\s+(?=[A-Z])|(?:,\s+(?:and\s+|then\s+)?|\s+(?:and|then)\s+)(?=(?:(?:finely|thinly|roughly|coarsely|lightly|gently)\s+)?(?:zest|juice|trim|peel|core|mince|chop|dice|slice|cut|measure|rinse|halve|quarter|grate|seed|pick|strip|smash|shred|combine|whisk|stir|add|toss|mix|pour|fold|place|transfer|melt|heat|bring|cook|roast|spread|arrange|season|scatter|sprinkle|layer|beat|pull|pat|put|reserve|refrigerate|cover|let|remove|serve|drain|bake|grill|sear|brush|set|thread|skewer|mash)\b)/gi;
/** PREP-3 3b — a work verb whose object the food is (straight after it, or in its list). */
export const WORKED_BEFORE = /\b(?:add|combine|stir|toss|fold|whisk|mix|sprinkle|scatter|top|rub|coat|brush|season|drizzle|pour|spoon|spread)\b(?:\s+(?:in|together|with))?\s+(?:[^;:.]*?(?:,\s+(?:and\s+)?|\s+and\s+))?(?:(?:the|a|an)\s+)?$/i;
/** PREP-3 3b — the shape a "cut … into" clause leaves: "into 1½-inch chunks", "into bite-sized florets". */
const SHAPE = /\binto\s+(?:[\d½¼¾⅓⅔.]+[-\s]?inch\s+|bite-sized\s+|thin\s+|small\s+|large\s+)?(chunks|pieces|cubes|strips|slices|wedges|rings|florets)\b/i;
// (THX-3d 3b — "rub": production's Make-Ahead "Smash 6 garlic cloves and quarter 1 yellow
// onion. Rub 6 tablespoons softened butter under the breast skin…")
const WORK_LEAD = /^(?:(?:in|on) (?:a|the) [a-z -]{0,30}, )?(?:combine|whisk|stir|add|toss|mix|pour|fold|place|transfer|melt|heat|bring|cook|roast|spread|arrange|season|scatter|sprinkle|layer|rub)\b/i;

/**
 * Rule 2 (content — patch.ts writes it, never read time): a step that opens with prep
 * and then does the dish's work is two steps, so rule 1 can say "skip" to the first
 * and the second still reads whole ("Zest 2 oranges, then juice them; combine the
 * cranberries…" → "Zest 2 oranges, then juice them." + "Combine the cranberries…").
 * The split is at "; " or ". " before a work verb; a work verb followed straight by
 * "into"/"in"/"with"/"over" takes "them" ("whisk into the filling" → "Whisk them into
 * the filling."). Both keep the day prefix. Null when the step is one or the other.
 */
const PARTICIPLE: Record<string, string> = { slice: "sliced", dice: "diced", chop: "chopped", mince: "minced", grate: "grated", cube: "cubed", halve: "halved", quarter: "quartered", shred: "shredded" };

/** What a prep clause leaves on the board: "the sliced shallots", "the potato chunks", "the green beans". */
function subjectOf(clause: string, ms: readonly Mention[]): string {
  const verb = /^(?:\w+ly\s+)?(\w+)/.exec(clause.trim())?.[1].toLowerCase() ?? "";
  // The food as the clause writes it ("6 shallots" → shallots), its amount and cut words gone.
  const asWritten = (m: Mention) =>
    clause.slice(m.start, m.end).toLowerCase()
      .replace(/^(?:the\s+)?[\d½¼¾⅓⅔⅛⅜⅝⅞.\s-]*(?:(?:pounds?|lbs?|oz|ounces?|teaspoons?|tablespoons?|tsp|tbsp|cups?|cloves?|sprigs?|stalks?|heads?|bunch(?:es)?)\s+)?/, "")
      .replace(/^(?:(?:finely|thinly|roughly|coarsely|chopped|sliced|minced|diced|trimmed|peeled|rinsed|fresh|whole|large|small|medium|ground)\s+)+/, "")
      .trim();
  const names = [...new Set(ms.map((m) => asWritten(m) || m.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).filter((w) => !GENERIC_WORD.test(w)).join(" ")))];
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  // THX-3d 3b — "Strip the leaves from 2 thyme sprigs" leaves the leaves, not the sprigs
  // (production's Classic gravy: "Stir the thyme sprigs in").
  if (verb === "strip" && /^strip\s+(?:the\s+)?leaves\s+(?:from|off)\b/i.test(clause.trim()) && names.length === 1) {
    return `the ${names[0].replace(/\s+(?:sprigs?|stems?|bunch(?:es)?)$/, "")} leaves`;
  }
  const participle = PARTICIPLE[verb];
  if (participle) return `the ${participle} ${list}`;
  const shape = /\binto\s+(?:[\d½¼¾⅓⅔.]+[-\s]?inch\s+)?(chunks|pieces|cubes|rings|wedges|strips|slices)\b/i.exec(clause)?.[1];
  // THX-3d 3b — the whole food, singular: "the sweet potato chunks", never "the potato chunks".
  if (shape && names.length === 1) {
    const words = names[0].split(/\s+/);
    return `the ${[...words.slice(0, -1), singular(words[words.length - 1])].join(" ")} ${shape.toLowerCase()}`;
  }
  return `the ${list}`;
}

export function splitPrepClause(text: string, rows: readonly WordingRow[], titles: readonly string[] = []): { prep: string; work: string } | null {
  const prefix = DAY_PREFIX.exec(text)?.[1] ?? "";
  const body = text.slice(prefix.length);
  if (!CUT_LEAD.test(body)) return null;
  // ("Trim 1 pound green beans and toss…": "and" or "then" before a work verb splits too.)
  for (const m of body.matchAll(/[;.]\s+|,?\s+(?:and|then)\s+/g)) {
    const a = body.slice(0, m.index);
    const b = body.slice(m.index! + m[0].length);
    if (!WORK_LEAD.test(b)) continue;
    // THX-3d 3b — no split where the work half is only a bowl ("…into 1-inch cubes; place
    // in a large bowl": the next step's toss is the work, and M's hold joins it), or is
    // the apples' toss with lemon (M: the cut step IS that toss, never "kept in water").
    if (/^place\s+(?:them\s+|it\s+)?in\s+(?:a|the)\s+(?:[a-z-]+\s+){0,2}bowl\s*\.?\s*$/i.test(b.trim())) return null;
    if (/^toss\b/i.test(b) && /\blemon\b/i.test(b.split(/[;.]\s/)[0])) return null;
    const ms = mentionsOf({ stepIndex: 0, text: a, amountRefs: null }, rows, titles);
    if (ms.length === 0 || !onlyPrepWords(a, ms)) return null;
    // Round 2 (K) — the work half NAMES what it works, never "them": Cook Mode interleaves
    // dishes, so the step before it on the screen is another dish's ("Toss them with
    // ¼ cup flour" followed the turkey's carve). "the sliced shallots", "the potato chunks".
    // THX-3d 3b — "them" is what the LAST sentence cut: "Trim 2½ lb green beans. Thinly
    // slice 4 shallots into rings and toss them with flour" tosses the shallots alone.
    const lastSentence = Math.max(-1, ...[...a.matchAll(/[;.]\s+/g)].map((x) => x.index! + x[0].length));
    const theirs = /\bthem\b/i.test(b.split(/[;,.]/)[0]) && lastSentence > 0 ? ms.filter((m) => m.start >= lastSentence) : [];
    const subject = subjectOf(theirs.length > 0 ? a.slice(lastSentence) : a, theirs.length > 0 ? theirs.map((m) => ({ ...m, start: m.start - lastSentence, end: m.end - lastSentence })) : ms);
    const named = /\bthem\b/i.test(b.split(/[;,.]/)[0])
      ? b.replace(/\bthem\b/i, subject)
      : b.replace(/^(\w+)\s+(?=(?:in|into|with|over|onto)\b)/i, `$1 ${subject} `);
    const work = named.charAt(0).toUpperCase() + named.slice(1);
    // "On Thursday:" once, on the first half; a make-ahead day stays on both (the Hub reads it).
    return { prep: `${prefix}${a.replace(/[,\s]+$/, "")}.`, work: `${/^\s*On /i.test(prefix) ? "" : prefix}${work}` };
  }
  return null;
}

interface Piece { text: string; from?: number }

/** Rebuild from pieces; a ref inside a copied piece moves with it, the rest are dropped. */
function rebuild(pieces: readonly Piece[], refs: readonly WordingRef[]): { text: string; refs: WordingRef[] } {
  let text = "";
  const out: WordingRef[] = [];
  for (const p of pieces) {
    const at = text.length;
    text += p.text;
    if (p.from === undefined) continue;
    for (const r of refs) if (r.charStart >= p.from && r.charEnd <= p.from + p.text.length) out.push({ ...r, charStart: at + r.charStart - p.from, charEnd: at + r.charEnd - p.from });
  }
  return { text, refs: out.sort((a, b) => a.charStart - b.charStart) };
}

/** One feast dish's steps, reworded (see the header). A step with nothing to change is returned as it was. */
/** A mention as a food on its own: "3 smashed garlic cloves" → "smashed garlic", "the juice of 1 lime" → "lime juice". */
function foodWords(span: string): string {
  let t = span.toLowerCase().replace(/\s*\((?:optional|if using)\)/g, "").replace(/\s*\(cut into [^)]*\)|,\s*cut into [^,]*,?/g, "").trim();
  const juice = /^(?:the\s+)?(juice|zest)(?:\s+and\s+(juice|zest))?\s+of\s+(?:[\d½¼¾⅓⅔⅛⅜⅝⅞.\s]+)?(?:the\s+)?(.+)$/.exec(t);
  if (juice) return `${singular(juice[3].split(/\s+/).pop()!)} ${juice[1]}${juice[2] ? ` and ${juice[2]}` : ""}`;
  t = t.replace(/^(?:the|a|an)\s+/, "")
    .replace(/^[\d½¼¾⅓⅔⅛⅜⅝⅞.\s-]*(?:(?:pounds?|lbs?|oz|ounces?|teaspoons?|tablespoons?|tsp|tbsp|cups?|cloves?|sprigs?|stalks?|heads?|bunch(?:es)?)\s+)?/, "")
    .replace(/\s+from\s+.*$/, "")
    .replace(/\s+(?:cloves?|stalks?|sprigs?)$/, "")
    .replace(/\bfresh\s+/g, "")
    .trim();
  return t;
}

const CITRUS_SQUEEZE = /\b([Ss])queeze\s+(?:the\s+juice\s+of\s+(?:[\d½¼¾⅓⅔⅛⅜⅝⅞]+\s+)?(?:the\s+)?(lemons?|limes?|oranges?)|(?:[\d½¼¾⅓⅔⅛⅜⅝⅞]+\s+)?(?:the\s+)?(lemons?|limes?|oranges?)(?:\s+juice)?|the\s+(lemon|lime|orange)\s+juice)\b/;

/** Round 2 (L) — a citrus juiced in Prep the feast is poured: "Pour the lemon juice you prepped over the beans". */
/** THX-3d 3b — two fruits squeezed together: "squeeze the juice of 2 oranges and 2 lemons over the bird". */
const CITRUS_SQUEEZE_TWO = /\b([Ss])queeze\s+the\s+juice\s+of\s+(?:[\d½¼¾⅓⅔⅛⅜⅝⅞]+\s+)?(lemons?|limes?|oranges?)\s+and\s+(?:[\d½¼¾⅓⅔⅛⅜⅝⅞]+\s+)?(lemons?|limes?|oranges?)\b/;

/** THX-3d round 5 (BUG-514) — a phrase with nothing in it: "pour  you prepped", "the you prepped", "()", a hole left between two words. */
const EMPTY_PHRASE = /(?:\b(?:the|a|an|pour|add|in|into|with|of|over)|\s)\s+you prepped\b|\(\s*\)|\S {2,}\S/i;

/**
 * THX-3d round 5 (D-WS9-321) — a container as a step's ref: Prep's id (its name when it gave
 * none — a shared tub's name lists every dish it feeds, so a long one goes by its hash) and
 * its label.
 */
const refOf = (label: string | null | undefined, id?: string): PreppedRef | null => {
  if (!label) return null;
  const raw = id ?? label;
  return { containerId: raw.length <= 120 ? raw : `h:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`, label };
};
/** The step with these refs added to its own, each container once, in the order used. */
function withRefs(s: WordingStep, refs: readonly (PreppedRef | null)[]): WordingStep {
  const all = [...(s.preppedRefs ?? []), ...refs.filter((r): r is PreppedRef => r !== null)];
  const out = all.filter((r, i) => all.findIndex((x) => x.containerId === r.containerId) === i);
  return out.length > 0 ? { ...s, preppedRefs: out } : s;
}

/** The step poured, and (round 5, BUG-514) the span the pour wrote: what is inside it is the pour's. */
function citrusPoured(step: WordingStep, facts: FeastDishFacts): { step: WordingStep; poured: readonly [number, number] | null } {
  const juiced = (fruit: string) => facts.cuts.find((c) => c.key.includes(fruit) && /juic/.test(c.note) && c.into);
  // THX-3d 3b — both juiced in Prep the feast: "pour the orange and lemon juice you
  // prepped" (production's New Twist read "pour the and juiced orange zest you prepped
  // and the lemons you prepped over the bird").
  const two = CITRUS_SQUEEZE_TWO.exec(step.text);
  if (two && juiced(singular(two[2])) && juiced(singular(two[3]))) {
    const pour = `${two[1] === "S" ? "Pour" : "pour"} the ${singular(two[2])} and ${singular(two[3])} juice you prepped`;
    const pieces: Piece[] = [{ text: step.text.slice(0, two.index), from: 0 }, { text: pour }, { text: step.text.slice(two.index + two[0].length), from: two.index + two[0].length }];
    const r = rebuild(pieces, step.amountRefs ?? []);
    const [a, b] = [juiced(singular(two[2]))!, juiced(singular(two[3]))!];
    return { step: withRefs({ ...step, text: r.text, amountRefs: step.amountRefs ? r.refs : step.amountRefs }, [refOf(a.into, a.containerId), refOf(b.into, b.containerId)]), poured: [two.index, two.index + pour.length] };
  }
  const m = CITRUS_SQUEEZE.exec(step.text);
  if (!m) return { step, poured: null };
  const fruit = singular(m[2] ?? m[3] ?? m[4]);
  const cut = juiced(fruit);
  if (!cut?.into) return { step, poured: null };
  // The container's own name only when the fruit is all it holds (Make-Ahead's lemon
  // shared a tub with the shallots for frying: those are not poured over the beans).
  const alone = facts.cuts.filter((c) => c.into === cut.into).every((c) => c.key.includes(fruit));
  const p = alone ? cutPhrase(cut.into, [], cut.kind) : null;
  // (A tub of zest and juice pours its juice: the zest went in at its own step.)
  const phrase = p && !/\bzest\b/i.test(p.phrase) ? p.phrase : `the ${fruit} juice you prepped`;
  const pour = `${m[1] === "S" ? "Pour" : "pour"} ${phrase}`;
  const pieces: Piece[] = [{ text: step.text.slice(0, m.index), from: 0 }, { text: pour }, { text: step.text.slice(m.index + m[0].length), from: m.index + m[0].length }];
  const r = rebuild(pieces, step.amountRefs ?? []);
  return { step: withRefs({ ...step, text: r.text, amountRefs: step.amountRefs ? r.refs : step.amountRefs }, [refOf(cut.into, cut.containerId)]), poured: [m.index, m.index + pour.length] };
}

export function rewordFeastSteps(
  steps: readonly WordingStep[],
  rows: readonly WordingRow[],
  facts: FeastDishFacts | undefined,
  /** The meal's dish titles: masked ("Sage and Onion Stuffing" is not sage) and a container's owner. */
  titles: readonly string[] = [],
  /**
   * PREP-3 (R1) — a weeknight's words, from what the cook ticked: no "Skip if you prepped"
   * (Cook Mode collapses a step prep did whole), a shared tub keeps the step's amount
   * (it feeds several days), a prepped cut leaves a step that does more, and a marinade
   * used as it was made is named by its label.
   */
  opts: {
    weeknight?: boolean;
    /** PREP-3 3b — the quantity Cook Mode shows for a ref (it scales by the row), so the noun agrees: "(1 clove)". */
    countOf?: (r: WordingRef) => number;
  } = {},
): WordingStep[] {
  if (!facts || (facts.mixes.length === 0 && facts.cuts.length === 0 && !facts.proteins?.length)) return [...steps];
  const nameOf = new Map(rows.map((r) => [r.ingredientId, r.name]));
  /**
   * A count's noun in the number the cook reads: "cloves" of a 2 shown as 1 is "clove".
   * THX-3d round 5 (BUG-515) — the number Cook Mode SHOWS: the scaled count rounded by
   * BUG-437's rule (a clove rounds up, the rest to the nearest ⅛), never the raw share.
   */
  const agree = (noun: string, r: WordingRef) => {
    const one = displayedPrepQuantity(opts.countOf?.(r) ?? r.quantity, r.unit, nameOf.get(r.ingredientId) ?? "") <= 1;
    if (one) return noun.replace(/ies$/i, "y").replace(/(?<=(?:s|x|z|ch|sh|o))es$/i, "").replace(/(?<!s)s$/i, "");
    return /s$/i.test(noun) ? noun : /[^aeiou]y$/i.test(noun) ? noun.replace(/y$/i, "ies") : /(?:s|x|z|ch|sh|o)$/i.test(noun) ? `${noun}es` : `${noun}s`;
  };
  /**
   * BUG-515 — what a bare number counts, from the words after it in its mention: a count
   * noun ("2 garlic cloves"), else the food's own last word ("½ lemon"), agreeing; null when
   * there is none — and a lone number never ships ("the lemon juice you prepped (½)").
   */
  const countNoun = (r: WordingRef, after: string): string | null => {
    const words = after.replace(/\s*\([^)]*\)/g, "").replace(/[,;:.].*$/, "");
    const noun = /\b(cloves?|stalks?|sprigs?|heads?)\b/i.exec(words)?.[1] ?? /\b([a-z]+)\s*$/i.exec(words)?.[1];
    return noun ? agree(noun, r) : null;
  };
  /**
   * THX-3d round 5 (BUG-514) — an empty phrase never ships: a step whose rewording left a
   * hole ("pour  you prepped over the top") keeps its stored words, and the hole is logged.
   */
  const keptWhole = (out: readonly WordingStep[]): WordingStep[] => out.map((s, i) => {
    const was = steps[i];
    if (s.text === was.text || !EMPTY_PHRASE.test(s.text) || EMPTY_PHRASE.test(was.text)) return s;
    logger.warn({ event: "cook_wording_empty_phrase", dishId: facts.dishId, stepIndex: s.stepIndex, text: s.text }, "Cook Mode wording left an empty phrase — the stored words are served");
    return was;
  });
  // PREP-3 — "fresh lemon juice" is the lemon juice prepped (the combine groups the two
  // under one id, so the cut's id is the group's, never this row's).
  const bare = (k: string) => k.replace(/\bfresh(?:ly squeezed)?\s+/g, "");
  const inMix = (mix: FeastDishFacts["mixes"][number], m: Mention) => mix.ids.has(m.id) || mix.keys.has(m.key) || [...mix.keys].some((k) => bare(k) === bare(m.key));
  const cutsOf = (m: Mention) => facts.cuts.filter((c) => c.id === m.id || c.key === m.key || bare(c.key) === bare(m.key));
  /** The prepped cut this mention asks for, when one matches its cut words. */
  const cutFor = (m: Mention) => cutsOf(m).find((c) => m.cut.every((w) => c.note.includes(w))) ?? null;
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const mentionsBy = new Map(steps.map((s) => [s.stepIndex, mentionsOf(s, rows, titles)]));

  // Rule 1 — a step whose whole job was Prep the feast's.
  const isSkip = (step: WordingStep): boolean => {
    const prefix = DAY_PREFIX.exec(step.text)?.[1] ?? "";
    const body = step.text.slice(prefix.length);
    const all = mentionsBy.get(step.stepIndex) ?? [];
    if (all.length === 0 || CODE_WRITTEN.test(step.text) || /^\s*skip if you prepped/i.test(body)) return false;
    if (!onlyPrepWords(step.text, all, prefix.length)) return false;
    return all.every((m) => {
      if (facts.mixes.some((x) => inMix(x, m))) return true;
      const c = cutFor(m);
      if (!c) return false;
      // A citrus the step zests AND juices must have been prepped both ways.
      if (CITRUS.test(m.name.split(/[,(]/)[0].trim())) {
        if (/\bzest/i.test(body) && !c.note.includes("zest")) return false;
        if (/\bjuic/i.test(body) && !c.note.includes("juic")) return false;
      }
      return true;
    });
  };
  const skips = new Set(ordered.filter(isSkip).map((s) => s.stepIndex));

  // Rule 3 — each mix's entry step: the first that states two of its members (one for a
  // one-member mix). Round 2 (K) — when that step is the measuring itself (a skip step),
  // the mix is named where it is used next: "Whisk the Cheesecake bars spice mix into
  // the filling", whether that step states the amounts or not.
  const entryOf = new Map<string, number>();
  const usedAfterSkip = new Set<string>();
  // PREP-3 — what the mix holds of a member over what a step states of it: the same for
  // every member of one portion (the household's scale), whatever the step's unit spelling.
  const unitKey = (u: string) => {
    const x = u.toLowerCase().replace(/\.$/, "");
    return /^(?:tsp|teaspoons?)$/.test(x) ? "tsp" : /^(?:tbsp|tbs|tablespoons?)$/.test(x) ? "tbsp" : /^cups?$/.test(x) ? "cup" : /^(?:oz|ounces?)$/.test(x) ? "oz" : /^(?:lbs?|pounds?)$/.test(x) ? "lb" : x.replace(/s$/, "");
  };
  const ratioOf = (mix: FeastDishFacts["mixes"][number], s: WordingStep, m: Mention): number | null => {
    const r = (s.amountRefs ?? []).find((x) => x.charStart >= m.start && x.charEnd <= m.end);
    const a = mix.amounts?.get(m.key) ?? [...(mix.amounts ?? new Map<string, { qty: number; unit: string }>())].find(([k]) => bare(k) === bare(m.key))?.[1];
    return r && a && r.quantity > 0 && unitKey(a.unit) === unitKey(r.unit) ? a.qty / r.quantity : null;
  };
  const scaleAt = (mix: FeastDishFacts["mixes"][number], s: WordingStep): number | null => {
    for (const m of mentionsBy.get(s.stepIndex) ?? []) if (m.ref && inMix(mix, m)) { const q = ratioOf(mix, s, m); if (q !== null) return q; }
    return null;
  };
  const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 0.02 * Math.max(a, b);
  const entryScale = new Map<string, number | null>();
  for (const mix of facts.mixes) {
    const n = Math.min(2, Math.max(1, mix.keys.size));
    const keysIn = (s: WordingStep, needRef: boolean) => new Set((mentionsBy.get(s.stepIndex) ?? []).filter((m) => (!needRef || m.ref) && inMix(mix, m)).map((m) => m.key)).size;
    const at = ordered.find((s) => keysIn(s, true) >= n);
    if (!at) continue;
    // PREP-3 — a week's mix enters where its first member's amount is stated, when that
    // is the same portion: hh4-mixed Friday soaked "½ cup plain breadcrumbs" at #0, then
    // added "the Friday dry mix" (which holds them) at #1. Now the mix is soaked at #0.
    if (opts.weeknight && !skips.has(at.stepIndex)) {
      const scale = scaleAt(mix, at);
      const early = ordered.find((s) => s.stepIndex < at.stepIndex && !skips.has(s.stepIndex) && keysIn(s, true) >= 1 &&
        (mentionsBy.get(s.stepIndex) ?? []).filter((m) => m.ref && inMix(mix, m)).every((m) => same(ratioOf(mix, s, m), scale)));
      if (early) { entryOf.set(mix.name, early.stepIndex); entryScale.set(mix.name, scale); continue; }
      entryScale.set(mix.name, scale);
    }
    if (!skips.has(at.stepIndex)) { entryOf.set(mix.name, at.stepIndex); continue; }
    const next = ordered.find((s) => s.stepIndex > at.stepIndex && !skips.has(s.stepIndex) && keysIn(s, false) >= n);
    if (next) { entryOf.set(mix.name, next.stepIndex); usedAfterSkip.add(mix.name); }
  }

  const worded = steps.map((original) => {
    if (CODE_WRITTEN.test(original.text)) return original;
    // PREP-3 (R1) — Cook Mode collapses it as done in prep: its words stay.
    if (opts.weeknight && facts.covered?.has(original.stepIndex)) return original;
    const prefix = DAY_PREFIX.exec(original.text)?.[1] ?? "";
    const body = original.text.slice(prefix.length);
    if (/^\s*skip if you prepped/i.test(body)) return original;
    if (skips.has(original.stepIndex)) {
      if (opts.weeknight) return original;
      const r = rebuild([{ text: prefix, from: 0 }, { text: "Skip if you prepped. Otherwise, " }, { text: body.slice(0, 1).toLowerCase() }, { text: body.slice(1), from: prefix.length + 1 }], original.amountRefs ?? []);
      // Round 5 (D-WS9-321) — what Prep the feast made of it.
      const made = (mentionsBy.get(original.stepIndex) ?? []).map((m) => {
        const mix = facts.mixes.find((x) => inMix(x, m));
        if (mix) return refOf(mix.name, mix.containerId);
        const c = cutFor(m);
        return c ? refOf(c.into, c.containerId) : null;
      });
      return withRefs({ ...original, text: r.text, amountRefs: original.amountRefs ? r.refs : original.amountRefs }, made);
    }
    // Round 2 (L) — a prepped citrus is poured, not squeezed: "Squeeze the juice of 1
    // lemon over the beans" → "Pour the Green beans citrus you prepped over the beans".
    const { step, poured } = citrusPoured(original, facts);
    // THX-3d round 5 (BUG-514) — a food inside the phrase the pour wrote is the pour's
    // ("pour the lemon juice you prepped over the top" lost "the lemon juice" as a container
    // "already said", and shipped "pour  you prepped over the top").
    const all = mentionsOf(step, rows, titles).filter((m) => !poured || m.end <= poured[0] || m.start >= poured[1]);
    if (all.length === 0) return step;
    const mixHere = (m: Mention) => facts.mixes.find((x) => inMix(x, m) && entryOf.get(x.name) === step.stepIndex) ?? null;

    // ── Rules 3 and 4 ─────────────────────────────────────────────────────────
    // A mix named after its skip step is named by its members as written (no amounts).
    const looseMix = new Set(all.filter((m) => { const x = mixHere(m); return !!x && usedAfterSkip.has(x.name); }));
    // PREP-3 3b (R2, every member) — a week's shared-tub food a step works is the tub's,
    // measured or not: "add the minced garlic, and sauté" → "add the minced garlic you prepped (2 cloves)".
    const worked = opts.weeknight ? all.filter((m) => cutFor(m)?.kind === "shared" && WORKED_BEFORE.test(step.text.slice(0, m.start).split(/[;:.]\s+/).pop() ?? "")) : [];
    const ms = [...new Set([...measured(step.text, all), ...looseMix, ...worked])].sort((a, b) => a.start - b.start);
    /** mention → its group; a group's phrase. */
    const groupOf = new Map<Mention, string>();
    const phraseOf = new Map<string, string>();
    const foodGroup = new Map<Mention, string>(); // per-food candidates: container → mentions
    const tubAmount = new Map<Mention, string>();
    /** Round 5 (D-WS9-321) — a group's container, for the step's preppedRefs. */
    const refOfGroup = new Map<string, PreppedRef | null>();
    const cutRef = (into: string) => { const c = facts.cuts.find((x) => x.into === into); return refOf(into, c?.containerId); };
    for (const m of ms) {
      const mix = mixHere(m);
      // Round 5 (D-WS9-321) — a mix is said as prepped: "the Taco spices you prepped".
      if (mix) { groupOf.set(m, `mix:${mix.name}`); phraseOf.set(`mix:${mix.name}`, `the ${mix.name} you prepped`); refOfGroup.set(`mix:${mix.name}`, refOf(mix.name, mix.containerId)); continue; }
      // PREP-3 — a week's member restated after its mix entered, the same portion, goes
      // (the mix brought it: "…, ½ teaspoon dried oregano, and ¼ teaspoon red pepper flakes").
      const brought = opts.weeknight && m.ref ? facts.mixes.find((x) => inMix(x, m) && (entryOf.get(x.name) ?? Infinity) < step.stepIndex && same(ratioOf(x, step, m), entryScale.get(x.name) ?? null)) : undefined;
      if (brought) { groupOf.set(m, `drop:${brought.name}`); phraseOf.set(`drop:${brought.name}`, ""); continue; }
      if (facts.mixes.some((x) => inMix(x, m))) continue; // a mix member away from its entry step: as written
      const c = cutFor(m);
      if (!c?.into) continue;
      // A cut that went into the jar entering here IS that jar (Small's stripped thyme in
      // the sweet potatoes' sauce): one mention, the jar's.
      if (c.kind === "mix" && facts.mixes.some((x) => x.name === c.into && entryOf.get(x.name) === step.stepIndex)) {
        const jar = facts.mixes.find((x) => x.name === c.into)!;
        groupOf.set(m, `mix:${c.into}`); phraseOf.set(`mix:${c.into}`, `the ${c.into} you prepped`); refOfGroup.set(`mix:${c.into}`, refOf(c.into, jar.containerId ?? c.containerId));
        continue;
      }
      const p = cutPhrase(c.into, titles, c.kind);
      if (p && !p.whole) {
        groupOf.set(m, `tub:${c.into}`);
        phraseOf.set(`tub:${c.into}`, p.phrase);
        refOfGroup.set(`tub:${c.into}`, cutRef(c.into));
        // PREP-3 3b — a step that states no amount takes the tub's share for this dish:
        // "Combine the romaine, …" → "Combine the chopped romaine lettuce you prepped (4 cups), …".
        if (opts.weeknight && c.amount && cutsOf(m).filter((x) => x.into === c.into).length === 1) tubAmount.set(m, c.amount);
        continue;
      }
      // PREP-3 — a week's bowl named for the dish being cooked ("Guacamole") is said by its
      // foods: "Fold in the Guacamole" reads as the dish itself.
      const namesDish = opts.weeknight && titles.some((t) => { const into = c.into!.toLowerCase(); return into === shortDish(t) || into.endsWith(` ${shortDish(t)}`); });
      if (p && p.whole && !namesDish) {
        // The whole container: only when one list of the step names everything it holds for this dish.
        const members = new Set(facts.cuts.filter((x) => x.into === c.into).map((x) => x.key));
        const named = ms.filter((o) => cutsOf(o).some((x) => x.into === c.into));
        const oneList = named.every((o, i) => i === 0 || listed(step.text, named[i - 1], o));
        if (oneList && [...members].every((k) => named.some((o) => o.key === k))) { groupOf.set(m, `whole:${c.into}`); phraseOf.set(`whole:${c.into}`, p.phrase); refOfGroup.set(`whole:${c.into}`, cutRef(c.into)); continue; }
      }
      // Round 2 (L) — a plate's pile, or part of a container a later step uses too: by
      // its food, "the smashed garlic, quartered onion and halved lemon you prepped".
      foodGroup.set(m, c.into);
    }
    // Per-food groups: one per run of listed mentions of one container.
    let run = 0;
    let prev: Mention | null = null;
    for (const m of ms) {
      const into = foodGroup.get(m);
      if (into === undefined) { prev = null; continue; }
      if (!prev || foodGroup.get(prev) !== into || !listed(step.text, prev, m)) run++;
      groupOf.set(m, `food:${into}#${run}`);
      refOfGroup.set(`food:${into}#${run}`, cutRef(into));
      prev = m;
    }
    for (const g of new Set(groupOf.values())) {
      if (!g.startsWith("food:")) continue;
      const foods = ms.filter((m) => groupOf.get(m) === g).map((m) => foodWords(step.text.slice(m.start, m.end)));
      const list = foods.length <= 1 ? foods.join("") : `${foods.slice(0, -1).join(", ")} and ${foods[foods.length - 1]}`;
      phraseOf.set(g, `the ${list} you prepped`);
    }
    // A group spans one list only: members in another clause leave the whole group as
    // written. And never as a cut verb's object ("mince the minced shallot you prepped").
    for (const g of new Set(groupOf.values())) {
      const members = ms.filter((m) => groupOf.get(m) === g);
      const oneList = members.every((m, i) => i === 0 || listed(step.text, members[i - 1], m));
      const cutVerb = /\b(?:chop|mince|dice|slice|trim|peel|zest|juice|grate|pick|strip|halve|quarter|rinse|measure|cut|squeeze|smash)(?:\s+and\s+(?:chop|mince|dice|slice|trim|peel|zest|juice|grate|halve))?\s+(?:the\s+)?$/i.test(step.text.slice(Math.max(0, members[0].start - 30), members[0].start));
      // THX-3d 3b — nor once the dish has cooked it: "the blanched green beans" are this
      // dish's own by then, not the prep's ("Add the blanched the green beans you prepped").
      const cooked = /\bthe\s+(?!(?:minced|chopped|diced|sliced|trimmed|peeled|grated|halved|quartered|smashed|julienned|shredded|cubed|zested|juiced|stripped|picked|rinsed|seeded|cored)\s)[a-z]+ed\s+$/i.test(step.text.slice(Math.max(0, members[0].start - 30), members[0].start));
      if (!oneList || cutVerb || cooked) for (const m of members) groupOf.delete(m);
    }
    // (A step whose foods all came with the mix is left as written: never "Stir in.")
    if (ms.every((m) => groupOf.get(m)?.startsWith("drop:"))) for (const m of ms) groupOf.delete(m);
    if (groupOf.size === 0) return step;

    type Edit = { start: number; end: number; text: string; pieces?: Piece[] };
    const edits: Edit[] = [];
    const firsts = new Map<string, Mention>();
    for (const m of ms) if (groupOf.has(m) && !firsts.has(groupOf.get(m)!)) firsts.set(groupOf.get(m)!, m);
    const removed: { m: Mention; start: number; end: number; hadAnd: boolean }[] = [];
    // THX-3d 3b — a food named by its shape goes whole: "onion quarters" is the quartered
    // onion ("the quartered yellow onion you prepped quarters" on production's Make-Ahead).
    const shapeAfter = (m: Mention) => /^\s+(?:quarters|halves|wedges|pieces|chunks|thirds)\b/.exec(step.text.slice(m.end))?.[0].length ?? 0;
    // …and a food written ", cut into pieces," mid-list keeps the list's comma: "the carrots
    // you prepped, the smashed garlic you prepped" (it read "…you prepped the smashed…").
    const listComma = (m: Mention) => (/,$/.test(step.text.slice(m.start, m.end)) && /^\s*(?:[\d½¼¾⅓⅔⅛⅜⅝⅞]|and\b|the\b)/.test(step.text.slice(m.end)) ? 1 : 0);
    for (const m0 of ms) {
      const g = groupOf.get(m0);
      if (!g) continue;
      const m = { ...m0, end: m0.end + shapeAfter(m0) - listComma(m0) };
      const phrase = phraseOf.get(g)!;
      // The citrus pour already said this container: its members here go.
      const said = step.text.toLowerCase().includes(phrase.toLowerCase()) && step.text.slice(m.start, m.end).toLowerCase() !== phrase.toLowerCase();
      if (firsts.get(g) === m0 && !said && !g.startsWith("drop:")) {
        // PREP-3 (R2) — a weeknight's shared tub feeds several days: the step keeps its
        // share, amount and all, "the minced garlic you prepped (4 cloves)", the amount
        // still the step's own (its ref moves with it and scales).
        const keep = opts.weeknight && g.startsWith("tub:") ? (step.amountRefs ?? []).find((r) => r.charStart >= m.start && r.charEnd <= m.end) : undefined;
        if (keep) {
          const amount = step.text.slice(keep.charStart, keep.charEnd);
          const bare = !/[a-z]/i.test(amount);
          const noun = bare ? countNoun(keep, step.text.slice(keep.charEnd, m.end)) : null;
          if (bare && !noun) edits.push({ start: m.start, end: m.end, text: phrase });
          else edits.push({ start: m.start, end: m.end, text: phrase, pieces: [{ text: `${phrase} (` }, { text: amount, from: keep.charStart }, { text: `${noun ? ` ${noun}` : ""})` }] });
        } else if (tubAmount.has(m0)) edits.push({ start: m.start, end: m.end, text: `${phrase} (${tubAmount.get(m0)})` });
        else if (step.text.slice(m.start, m.end).toLowerCase() !== phrase.toLowerCase()) edits.push({ start: m.start, end: m.end, text: phrase });
        continue;
      }
      const before = SEPARATOR_BEFORE.exec(step.text.slice(0, m.start));
      if (before) {
        edits.push({ start: m.start - before[0].length, end: m.end, text: "" });
        removed.push({ m: m0, start: m.start - before[0].length, end: m.end, hadAnd: /\band\b/.test(before[0]) });
      } else {
        const after = SEPARATOR_AFTER.exec(step.text.slice(m.end));
        edits.push({ start: m.start, end: m.end + (after?.[0].length ?? 0), text: "" });
      }
    }
    // A removed last item took the list's "and": the separator before the new last item
    // takes it — ", and " with three or more items left, " and " with two.
    // A kept ", and " left after one item reads " and ".
    const gone = (at: number) => edits.some((e) => e.text === "" && e.start <= at && at < e.end);
    const fixed = new Set<number>();
    for (const r of removed) {
      // The list starts at its first food ("In a medium bowl, combine" is not an item).
      const clauseFrom = Math.max(prefix.length, ...[...step.text.slice(0, r.start).matchAll(/[;:.]\s*/g)].map((x) => (x.index ?? 0) + x[0].length));
      // (…or an amount of a food the dish does not list: "Stir in 12 oz cheddar, …".)
      const firstNumber = /[\d½¼¾⅓⅔⅛⅜⅝⅞]/.exec(step.text.slice(clauseFrom));
      const clauseStart = Math.min(r.m.start, ...all.filter((o) => o.start >= clauseFrom).map((o) => o.start), ...(step.amountRefs ?? []).filter((x) => x.charStart >= clauseFrom).map((x) => x.charStart), firstNumber ? clauseFrom + firstNumber.index : Infinity);
      if (!r.hadAnd) {
        const tail = step.text.slice(r.end);
        const and = /^[^;:.]*?,\s+and\s+/.exec(tail);
        if (!and) continue;
        const at = r.end + and[0].length - and[0].replace(/^[^;:.]*?(?=,\s+and\s+)/, "").length;
        if (gone(at) || fixed.has(at)) continue;
        const before = [...step.text.slice(clauseStart, at).matchAll(/,\s+/g)].map((x) => clauseStart + (x.index ?? 0)).filter((c) => !gone(c));
        if (before.length === 0) { fixed.add(at); edits.push({ start: at, end: at + /^,\s+/.exec(step.text.slice(at))![0].length, text: " " }); }
        continue;
      }
      const commas = [...step.text.slice(clauseStart, r.start).matchAll(/,\s+/g)]
        .map((x) => clauseStart + (x.index ?? 0))
        .filter((at) => !gone(at));
      const lastComma = commas[commas.length - 1];
      if (lastComma === undefined) continue;
      edits.push({ start: lastComma, end: lastComma + 2, text: commas.length >= 2 ? ", and " : " and " });
    }
    edits.sort((a, b) => a.start - b.start || b.end - a.end);
    const pieces: Piece[] = [];
    let cursor = 0;
    for (const e of edits) {
      if (e.start < cursor) continue;
      pieces.push({ text: step.text.slice(cursor, e.start), from: cursor }, ...(e.pieces ?? [{ text: e.text }]));
      cursor = e.end;
    }
    pieces.push({ text: step.text.slice(cursor), from: cursor });
    const r = rebuild(pieces, step.amountRefs ?? []);
    if (r.text === step.text) return step;
    const used = [...new Set([...groupOf.values()].filter((g) => !g.startsWith("drop:")))].map((g) => refOfGroup.get(g) ?? null);
    return withRefs({ ...step, text: r.text, amountRefs: step.amountRefs ? r.refs : step.amountRefs }, used);
  });
  if (!opts.weeknight) return keptWhole(worded);

  // ── PREP-3 (R1) — a prepped cut leaves a step that does more ─────────────────────────
  // "Lightly beat 2 large eggs with ⅛ teaspoon white pepper, and thinly slice 1½ scallions,
  // keeping the whites and greens separated." with the scallions on Wednesday's plate:
  // the cut clause goes, the beating stays. Only a clause that is nothing but the cut of
  // foods the cook prepped that way, and never the step's only clause.
  // PREP-3 3b — a step may cut again a protein Proteins cut ("Cut the 2 pounds of chicken thighs into 1½-inch chunks").
  const cutsOfAll = (m: Mention) => [...cutsOf(m), ...(facts.proteins ?? []).filter((c) => c.id === m.id || c.key === m.key)];
  const dropPrepped = (s: WordingStep): WordingStep => {
    if (skips.has(s.stepIndex) || facts.covered?.has(s.stepIndex) || CODE_WRITTEN.test(s.text)) return s;
    const prefix = DAY_PREFIX.exec(s.text)?.[1] ?? "";
    // A clause starts where a verb does: never inside a list of foods ("the onion and celery").
    let seps = [...s.text.slice(prefix.length).matchAll(CLAUSE_SEP)].map((x) => ({ start: prefix.length + x.index!, end: prefix.length + x.index! + x[0].length }));
    const clausesOf = () => {
      const out: { start: number; end: number }[] = [];
      let at = prefix.length;
      for (const sep of seps) { out.push({ start: at, end: sep.start }); at = sep.end; }
      out.push({ start: at, end: s.text.length });
      return out;
    };
    // A clause that names no food ("Zest" of "Zest and juice 1 lemon") goes with the next.
    // (Only a bare verb: "Mince 2 chipotle peppers in adobo to a smooth paste" is a clause.)
    // PREP-3 3b — any other short clause goes with the one before it: "…turkey breast and
    // set aside; finely dice the yellow onion" had made "set aside; finely dice …" one clause.
    const first = clausesOf();
    const short = first.map((c) => {
      const text = s.text.slice(c.start, c.end);
      return text.trim().split(/\s+/).length <= 2 && mentionsOf({ stepIndex: s.stepIndex, text, amountRefs: null }, rows, titles).length === 0;
    });
    // (A bare verb waits for its object: "…, and drain and rinse the beans".)
    const forward = (i: number) => short[i] && (i === 0 || s.text.slice(first[i].start, first[i].end).trim().split(/\s+/).length === 1);
    seps = seps.filter((_, i) => !forward(i) && !(short[i + 1] && !forward(i + 1)));
    const clauses = clausesOf();
    if (clauses.length < 2) return s;
    const gone = clauses.map((c) => {
      const text = s.text.slice(c.start, c.end).replace(/[.\s]+$/, "");
      if (!CUT_LEAD.test(text) && !/^cut\b/i.test(text)) return false;
      const ms = mentionsOf({ stepIndex: s.stepIndex, text, amountRefs: null }, rows, titles);
      if (ms.length === 0 || !onlyPrepWords(text, ms)) return false;
      // (A plural is the food's noun, never the verb: "the 4 bacon slices" are not sliced.)
      const verbs = CUT_WORDS.filter((w) => new RegExp(`\\b${w}(?!s\\b)`, "i").test(text));
      // ("…and measure 1 tablespoon adobo sauce from the can": the Chipotle crema sauce holds it.)
      if (/^measure\b/i.test(text) && ms.every((m) => facts.mixes.some((x) => inMix(x, m)))) return true;
      // PREP-3 3b — "Cut … into 1½-inch chunks" is the prepped cut when it was cut to that
      // shape (the chicken in Proteins, the red onion on the Skewers plate).
      const shape = /^cut\b/i.test(text) ? SHAPE.exec(text)?.[1].toLowerCase() : undefined;
      // (Chunks, pieces, florets and cubes are one shape; strips, slices, rings and wedges each their own.)
      const lumps = /^(?:chunks|pieces|florets|cubes)$/;
      const fits = (note: string) => !shape || note.includes(shape) || (lumps.test(shape) && /\b(?:chunks|pieces|florets|cubes)\b/.test(note)) || !/\binto\b/.test(note);
      return ms.every((m) => cutsOfAll(m).some((c) => verbs.every((w) => c.note.includes(w)) && fits(c.note)));
    });
    if (!gone.some(Boolean) || gone.every(Boolean)) return s;
    // A kept clause that works what the dropped ones cut ("…, then stir both into the
    // butter") names it: "Stir the minced garlic (4 cloves) and chopped flat-leaf parsley
    // (2 tablespoons) you prepped into the butter" — a shared tub's share keeps its amount.
    const all = mentionsOf(s, rows, titles);
    /** Round 5 (D-WS9-321) — the containers the kept clauses now name. */
    const used: (PreppedRef | null)[] = [];
    /** One dropped food as the cut left it: "minced garlic" + "(1 clove)", "chicken chunks" + "(2 pounds)". */
    const partOf = (j: number, m: Mention): { food: string; amount: Piece[] } | null => {
      const clause = s.text.slice(clauses[j].start, clauses[j].end);
      const verb = /^(?:\w+ly\s+)?(\w+)/.exec(clause.trim())?.[1].toLowerCase() ?? "";
      // The cut this clause did (the garlic minced to a paste, not the clove halved for the croutons).
      const verbs = CUT_WORDS.filter((w) => new RegExp(`\\b${w}(?!s\\b)`, "i").test(clause));
      const rank = (x: { note: string }) => Math.min(...verbs.map((w) => (x.note.indexOf(w) < 0 ? Infinity : x.note.indexOf(w))), verbs.length ? Infinity : 0);
      const c = [...cutsOfAll(m)].sort((a, b) => rank(a) - rank(b))[0];
      if (!c) return null;
      used.push(refOf(c.into, c.containerId));
      const words = foodWords(s.text.slice(m.start, m.end)).replace(/^of\s+/, "");
      const shape = verb === "cut" ? SHAPE.exec(clause)?.[1].toLowerCase() : undefined;
      const food = shape ? `${words.replace(/\s+(?:thighs?|breasts?|tenderloins?|fillets?|cutlets?|legs?|drumsticks?|wings?|loins?|shoulders?)$/i, "")} ${shape}` : `${PARTICIPLE[verb] ? `${PARTICIPLE[verb]} ` : ""}${words}`;
      // A shared tub's share, and a package's, keeps the step's amount ("the 2 pounds of chicken thighs").
      const keeps = ("kind" in c && c.kind === "shared") || (facts.proteins ?? []).includes(c);
      const r = keeps ? (s.amountRefs ?? []).find((x) => (x.charStart >= m.start && x.charEnd <= m.end) || (x.charStart >= clauses[j].start && x.charEnd <= m.start && /^\s+(?:of\s+)?(?:the\s+)?$/i.test(s.text.slice(x.charEnd, m.start)))) : undefined;
      if (!r) return { food, amount: [] };
      const amount = s.text.slice(r.charStart, r.charEnd);
      const bare = !/[a-z]/i.test(amount);
      const noun = bare ? countNoun(r, s.text.slice(r.charEnd, m.end)) : null;
      // (BUG-515 — a bare number with nothing to count goes.)
      if (bare && !noun) return { food, amount: [] };
      return { food, amount: [{ text: amount, from: r.charStart }, ...(noun ? [{ text: ` ${noun}` }] : [])] };
    };
    /** The dropped foods, said once: "the minced garlic you prepped (1 clove)"; two or more carry their own amounts. */
    const said = (parts: { food: string; amount: Piece[] }[]): Piece[] => {
      if (parts.length === 1) return [{ text: `the ${parts[0].food} you prepped` }, ...(parts[0].amount.length ? [{ text: " (" }, ...parts[0].amount, { text: ")" }] : [])];
      const out: Piece[] = [{ text: "the " }];
      parts.forEach((p, k) => {
        if (k > 0) out.push({ text: k === parts.length - 1 ? (parts.length > 2 ? ", and " : " and ") : ", " });
        out.push({ text: p.food }, ...(p.amount.length ? [{ text: " (" }, ...p.amount, { text: ")" }] : []));
      });
      out.push({ text: " you prepped" });
      return out;
    };
    const droppedIn = (from: number, to: number) => {
      const out: { j: number; m: Mention }[] = [];
      for (let j = from; j < to; j++) for (const m of all.filter((o) => o.start >= clauses[j].start && o.end <= clauses[j].end)) out.push({ j, m });
      return out;
    };
    const handOff = (from: number, to: number): Piece[] | null => {
      const parts = droppedIn(from, to).map(({ j, m }) => partOf(j, m));
      if (parts.length === 0 || parts.some((p) => !p)) return null;
      return said(parts as { food: string; amount: Piece[] }[]);
    };
    // Each dropped clause takes the separator before it (after it, when it opens the step).
    const pieces: Piece[] = [{ text: s.text.slice(0, prefix.length), from: 0 }];
    let after = 0;
    let ok = true;
    clauses.forEach((c, i) => {
      if (gone[i]) return;
      const lead = pieces.length > 1 && i > 0 ? s.text.slice(seps[i - 1].start, seps[i - 1].end) : "";
      if (lead) pieces.push({ text: lead, from: seps[i - 1].start });
      const pronoun = i > 0 && gone[i - 1] ? /^(\w+\s+)(both|them|it|everything)\b/i.exec(s.text.slice(c.start, c.end)) : null;
      let from = i - 1;
      while (from > after && gone[from - 1]) from--;
      const text = s.text.slice(c.start, c.end);
      // PREP-3 3b — the paste the dropped clause made is now the food itself: "Mince 1 garlic
      // clove to a fine paste, then mash 4 drained anchovy fillets into the paste" → "Mash the
      // minced garlic you prepped (1 clove) and 4 drained anchovy fillets together".
      const paste = i > 0 && gone[i - 1] && /\bto a (?:\w+\s+)?paste\b/i.test(s.text.slice(clauses[i - 1].start, clauses[i - 1].end)) ? /^(\w+\s+)(.+?)\s+into the paste\b/i.exec(text) : null;
      // …and a food the dropped clause cut, named again here, is the cut: "Cut the red onion
      // into 1½-inch chunks and thread the chicken and onion pieces" → "Thread the chicken
      // and the red onion chunks you prepped".
      // …and a verb whose object was the dropped food takes it: "…, and add to the bowl" →
      // "Add the sliced jalapeño you prepped to the bowl"; "then pat dry" → "Pat the … dry".
      const bare = i > 0 && gone[i - 1] && !pronoun && !paste ? /^(\w+)\s+(?=(?:dry|to|into|onto|over|with)\b)/i.exec(text) : null;
      const again = i > 0 && gone[i - 1] && !pronoun && !paste && !bare
        ? droppedIn(from, i).flatMap(({ j, m }) => all.filter((o) => o.start >= c.start && o.end <= c.end && (o.id === m.id || o.key === m.key)).slice(0, 1).map((o) => ({ j, m, o })))
        : [];
      if (pronoun) {
        const named = handOff(from, i);
        if (!named) { ok = false; return; }
        pieces.push({ text: pronoun[1], from: c.start }, ...named, { text: s.text.slice(c.start + pronoun[0].length, c.end), from: c.start + pronoun[0].length });
      } else if (paste) {
        const named = handOff(from, i);
        if (!named) { ok = false; return; }
        const objAt = c.start + paste[1].length;
        const restAt = c.start + paste[0].length;
        pieces.push({ text: paste[1], from: c.start }, ...named, { text: " and " }, { text: paste[2], from: objAt }, { text: " together" }, { text: s.text.slice(restAt, c.end), from: restAt });
      } else if (bare) {
        const named = handOff(from, i);
        if (!named) { ok = false; return; }
        pieces.push({ text: bare[0], from: c.start }, ...named, { text: " " }, { text: s.text.slice(c.start + bare[0].length, c.end), from: c.start + bare[0].length });
      } else if (again.length > 0) {
        let at = c.start;
        for (const { j, m, o } of again.sort((x, y) => x.o.start - y.o.start)) {
          const p = partOf(j, m);
          if (!p) { ok = false; return; }
          pieces.push({ text: s.text.slice(at, o.start), from: at }, ...said([p]));
          at = o.end;
        }
        pieces.push({ text: s.text.slice(at, c.end), from: at });
      } else pieces.push({ text, from: c.start });
      after = i + 1;
    });
    if (!ok) return s;
    const r = rebuild(pieces, s.amountRefs ?? []);
    let text = r.text.replace(/[,;\s]+$/, "");
    if (!/[.!]$/.test(text)) text += ".";
    // The step may now open on what was its second clause: it opens with a capital.
    const k = prefix.length;
    text = text.slice(0, k) + text.charAt(k).toUpperCase() + text.slice(k + 1);
    return withRefs({ ...s, text, amountRefs: s.amountRefs ? r.refs : s.amountRefs }, used);
  };

  // ── PREP-3 (R4) — the marinade made whole at prep is named where it is used ───────────
  // "Coat the chicken breasts evenly in the marinade" → "… in the Lemon pepper marinade".
  const renamedUse = (s: WordingStep): WordingStep => {
    let out = s;
    for (const mix of facts.mixes) {
      if (!/ marinade$/i.test(mix.name)) continue;
      const entry = ordered.find((x) => new Set((mentionsBy.get(x.stepIndex) ?? []).filter((m) => m.ref && inMix(mix, m)).map((m) => m.key)).size >= Math.min(2, mix.keys.size));
      if (!entry || !(skips.has(entry.stepIndex) || facts.covered?.has(entry.stepIndex)) || usedAfterSkip.has(mix.name) || s.stepIndex <= entry.stepIndex) continue;
      // ("the marinade bowl" is the jar too: "add them to the Skewers marinade".)
      const m = /\bthe marinade(?:\s+(?:bowl|jar|container))?\b/i.exec(out.text);
      if (!m) continue;
      // Round 5 (D-WS9-321) — said as prepped: "add them to the Skewers marinade you prepped".
      const r = rebuild([{ text: out.text.slice(0, m.index), from: 0 }, { text: `the ${mix.name} you prepped` }, { text: out.text.slice(m.index + m[0].length), from: m.index + m[0].length }], out.amountRefs ?? []);
      out = withRefs({ ...out, text: r.text, amountRefs: out.amountRefs ? r.refs : out.amountRefs }, [refOf(mix.name, mix.containerId)]);
    }
    return out;
  };
  return keptWhole(worded.map((s) => renamedUse(dropPrepped(s))));
}
