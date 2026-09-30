// ─────────────────────────────────────────────────────────────────────────────
// THE CHECKER — K-R1…K-R6 (Cook Mode) and P-R1…P-R6 (Prep the Week) over every
// plan the census wrote into out/. READ-ONLY, no DB, no AI: it reads the JSON
// the harness saved, so it is re-runnable and deterministic.
//
//   node --import tsx scripts/prep-cook-census/check.ts --tag live
//
// ⚠️ THE DETECTORS ARE DELIBERATELY INDEPENDENT OF THE CODE UNDER TEST. Nothing
// here imports cookingScheduler or prepWeekAssembly: a shared predicate would
// let a bug hide from its own detector. The offsets, phases and prose are read
// as DATA.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const TAG = arg("tag", "live")!;
const EXAMPLES = Number(arg("examples", "3"));

// ── the corpus shapes (mirrors census.ts; declared, not imported, so the
//    checker keeps reading saved JSON as data) ─────────────────────────────
interface CookStep {
  sequenceIndex: number;
  dishId: string;
  dishTitle: string | null;
  originalStepIndex: number;
  startOffsetMinutes: number | null;
  estimatedMinutes: number;
  phaseType: string;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
  cue: string | null;
  text: string;
  appended: boolean;
}
interface CookMeal {
  mealId: string;
  mealTitle: string;
  assignedDayOfWeek: string | null;
  assignedDate: string | null;
  hasRecipeOverride: boolean;
  dishCount: number;
  sequenceTotalMinutes: number;
  cardTotalMinutes: number;
  cardActiveMinutes: number | null;
  derivedTotalMinutes: number | null;
  derivedActiveMinutes: number | null;
  steps: CookStep[];
}
interface PrepStep {
  stepKey: string;
  phase: string;
  phaseTitle: string;
  number: number;
  title: string;
  instructions: string;
  estimatedMinutes: number;
  storageNote: string | null;
  skipSuggested: boolean;
  rendered: boolean;
  contributesToMealIds: string[];
  destinationLabels: string[];
}
interface PlanRecord {
  planId: string;
  planName: string | null;
  startDate: string | null;
  endDate: string | null;
  mealCount: number;
  datedItems: number;
  dayByMealId: Record<string, { day: string | null; date: string | null }>;
  prep: { totalEstimatedMinutes: number; renderedTotalMinutes: number; steps: PrepStep[]; plannedStepCount: number } | null;
  prepError: string | null;
  meals: CookMeal[];
}
// The narration input the AI was handed, per plan — P-R1/P-R2's structural source.
interface NarrationMeasure { amount: string; forDish: string; preparationNote?: string | null }
interface NarrationComponent { ingredientName: string; preparationNote?: string | null; measures: NarrationMeasure[] }
interface NarrationStep {
  stepId: string;
  phase: string;
  isBlend?: boolean;
  components: NarrationComponent[];
  relevantDishes?: string[];
  blendSpiceDish?: string | null;
}
interface NarrationInput { planName?: string; steps: NarrationStep[]; dishSteps?: Record<string, string[]> }

// ── findings ────────────────────────────────────────────────────────────────
interface Finding { rule: string; plan: string; where: string; detail: string }
const findings: Finding[] = [];
const hit = (rule: string, plan: string, where: string, detail: string) =>
  findings.push({ rule, plan, where, detail });

// Denominators: a rate needs the population it is a rate over.
/** K-R6's context rows — reported, never counted. */
const context: { plan: string; label: string; serialSum: number; schedule: number; card: number }[] = [];

const denom: Record<string, number> = {};
const bump = (k: string, n = 1) => { denom[k] = (denom[k] ?? 0) + n; };

// ── shared text knowledge (checker-local) ───────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Actions whose prose is NOT heat, even on a `cook`-phase row. K-R3's gerund test. */
const NON_HEAT_OPENERS = [
  "rinse", "wash", "soak", "marinate", "combine", "whisk", "stir together",
  "cover and refrigerate", "refrigerate", "chill", "toss", "season", "sprinkle",
  "drain", "pat dry", "measure", "set aside", "let sit", "place the", "transfer",
];
/** A dish that is served cold — "stays warm" is never true of it. */
const COLD_DISH_WORDS = [
  "guacamole", "salsa", "pico", "slaw", "salad", "dressing", "vinaigrette",
  "sour cream", "crema", "dip", "relish", "chutney", "yogurt sauce", "tzatziki",
  "cucumber salad", "raita",
];
const CHILL_WORDS = ["refrigerate", "chill", "fridge", "cold", "ice bath", "cool completely"];
/** Last words that end in "s" but are grammatically singular — no plural flag. */
const SINGULAR_S = new Set([
  "couscous", "hummus", "asparagus", "rice", "grits", "molasses", "bass", "swiss",
]);

const CITRUS = ["lime", "lemon", "orange", "grapefruit"];
/** P-R3's P1 class: the perishables a wrong storage window makes unsafe, not just wasteful. */
// ⚠️ WORD-ANCHORED, and "chop" is NOT a member. The first version listed the
// bare token and tagged "Chop the fresh cilantro" as raw flesh; only the noun
// senses ("pork chop", "lamb chops") belong here.
const RAW_PROTEIN_RE =
  /\b(salmon|cod|halibut|tilapia|tuna|shrimp|scallops?|fish|fillets?|chicken|beef|steaks?|pork|lamb|turkey|sausages?|bacon|skirt|flank|breasts?|thighs?|drumsticks?|tenderloin|brisket|(?:pork|lamb|veal) chops?|ground (?:beef|turkey|pork|chicken|lamb))\b/;

// ── K-R1 … K-R6 ─────────────────────────────────────────────────────────────

/** Steps of one dish in the dish's OWN order (originalStepIndex), with offsets. */
function dishSlices(meal: CookMeal): Map<string, CookStep[]> {
  const m = new Map<string, CookStep[]>();
  for (const s of meal.steps) {
    const l = m.get(s.dishId);
    if (l) l.push(s); else m.set(s.dishId, [s]);
  }
  for (const l of m.values()) l.sort((a, b) => a.originalStepIndex - b.originalStepIndex);
  return m;
}
const finishOf = (s: CookStep) => (s.startOffsetMinutes ?? 0) + s.estimatedMinutes;
const isUnattended = (s: CookStep) =>
  s.phaseType === "preheat" || s.phaseType === "rest" || s.phaseType === "hold" ||
  (s.phaseType === "cook" && !s.isTimingSensitive);

function checkCookMeal(plan: PlanRecord, meal: CookMeal) {
  const label = `${plan.planId.slice(0, 8)} · ${meal.mealTitle.slice(0, 48)}`;
  const slices = dishSlices(meal);

  // ── K-R1 — a rest step follows its heat step with ≤ 2 min between ────────
  for (const [, steps] of slices) {
    for (let i = 1; i < steps.length; i++) {
      const rest = steps[i];
      if (rest.phaseType !== "rest") continue;
      const prev = steps[i - 1];
      if (prev.phaseType !== "cook") continue; // only a rest that follows heat
      bump("K-R1");
      if (rest.startOffsetMinutes == null || prev.startOffsetMinutes == null) continue;
      const gap = rest.startOffsetMinutes - finishOf(prev);
      if (gap > 2) {
        hit("K-R1", plan.planId, label,
          `${rest.dishTitle ?? "?"}: rest at T${rest.startOffsetMinutes} is ${gap} min after its cook step finished (T${finishOf(prev)}) — "${rest.text.slice(0, 90)}"`);
      }
    }
  }

  // ── K-R2 — nothing holds in the pan; nothing hot finishes materially early
  for (const [, steps] of slices) {
    // (a) INTRA-DISH: a cook step whose own dish's next step starts > 5 min later
    //     and is not a rest/hold. The food sits where it was cooked.
    for (let i = 0; i < steps.length - 1; i++) {
      const s = steps[i];
      if (s.phaseType !== "cook") continue;
      const next = steps[i + 1];
      if (next.phaseType === "rest" || next.phaseType === "hold") continue;
      bump("K-R2");
      if (s.startOffsetMinutes == null || next.startOffsetMinutes == null) continue;
      const gap = next.startOffsetMinutes - finishOf(s);
      if (gap > 5) {
        hit("K-R2", plan.planId, label,
          `${s.dishTitle ?? "?"}: holds ${gap} min between "${s.text.slice(0, 60)}" (ends T${finishOf(s)}) and "${next.text.slice(0, 60)}" (T${next.startOffsetMinutes})`);
      }
    }
    // (b) THE DISH AS A WHOLE: its last hot finish vs serve (offset 0), unless
    //     a rest/hold follows it (then the rest window is the answer).
    const lastHot = [...steps].reverse().find((s) => s.phaseType === "cook");
    if (!lastHot || lastHot.startOffsetMinutes == null) continue;
    const after = steps.slice(steps.indexOf(lastHot) + 1);
    if (after.some((s) => s.phaseType === "rest" || s.phaseType === "hold")) continue;
    if (after.length > 0) continue; // a later assemble step is the finishing act
    bump("K-R2");
    const early = -finishOf(lastHot);
    if (early > 5) {
      hit("K-R2", plan.planId, label,
        `${lastHot.dishTitle ?? "?"}: last hot step finishes ${early} min before serve with no rest/hold — "${lastHot.text.slice(0, 80)}"`);
    }
  }

  // ── K-R3 — the connective phrase is true at that moment ──────────────────
  // ⚠️ BOTH WORDINGS. The pre-B1 form was "While the X cooks"; D-WS9-297 ruling 2
  // replaced it with the agreement-free "With the X cooking". A checker that knew
  // only the old one reported all 193 after-state cues as UNPARSEABLE and made a
  // fix read as a 68% regression. It parses either, so the before/after table
  // compares truth rather than spelling.
  const CUE_RE =
    /^(?:While the (.+?) (cooks|rests|heats up|stays warm|comes together)|With the (.+?) (cooking|resting|heating up|staying warm|marinating|chilling)), start on the (.+?)\.$/;
  for (const s of meal.steps) {
    if (!s.cue) continue;
    bump("K-R3");
    const m = CUE_RE.exec(s.cue);
    if (!m) {
      hit("K-R3", plan.planId, label, `unparseable cue: "${s.cue}"`);
      continue;
    }
    const windowTitle = m[1] ?? m[3];
    const rawState = m[2] ?? m[4];
    // Normalise the two spellings onto one vocabulary for the arms below.
    const gerund =
      rawState === "cooking" ? "cooks"
      : rawState === "resting" ? "rests"
      : rawState === "heating up" ? "heats up"
      : rawState === "staying warm" ? "stays warm"
      : rawState;
    // The window the scheduler meant: another dish's unattended step running now.
    const cands = meal.steps.filter(
      (o) => o.dishId !== s.dishId && o.dishTitle === windowTitle && isUnattended(o) &&
        o.startOffsetMinutes != null && s.startOffsetMinutes != null &&
        o.startOffsetMinutes <= s.startOffsetMinutes && finishOf(o) > s.startOffsetMinutes,
    );
    const w = cands[0];
    if (!w) {
      hit("K-R3", plan.planId, label, `cue names "${windowTitle}" but no unattended step of it is running at T${s.startOffsetMinutes}: "${s.cue}"`);
      continue;
    }
    // 1. ORDER — the window must already be underway in the flow the cook reads.
    //    A cue that points at a step further down the list is false when read.
    if (w.sequenceIndex > s.sequenceIndex) {
      hit("K-R3", plan.planId, label,
        `#${s.sequenceIndex + 1} cue points FORWARD to step #${w.sequenceIndex + 1} (same start T${w.startOffsetMinutes}) — the cook has not begun it: "${s.cue}"`);
    }
    // 2. "stays warm" on a cold dish.
    const wt = norm(windowTitle);
    const wtext = norm(w.text);
    if (gerund === "marinating" || gerund === "chilling") {
      // Ruling 2's own vocabulary. Nothing to flag: the cue is SAYING it is a
      // marinade or a chill, which is the fix rather than the defect.
    } else if (gerund === "stays warm") {
      const cold = COLD_DISH_WORDS.some((c) => wt.includes(c)) || CHILL_WORDS.some((c) => wtext.includes(c));
      if (cold) {
        hit("K-R3", plan.planId, label, `"stays warm" on a cold/chilled dish: "${s.cue}" (window step: "${w.text.slice(0, 70)}")`);
      }
    }
    // 3. "cooks" when the window step's own prose is not a heat action.
    //
    // ⚠️ A NON-HEAT OPENER IS NOT A NON-HEAT STEP, and the opener test alone
    // reported 10 false positives: "Place the bread cut-side up and BAKE for
    // 10–12 minutes" opens with "place the" and is unambiguously cooking. The
    // step has to lack a heat verb ANYWHERE, which is also the rule the
    // production `passiveStateOf` applies — stated separately here (a shared
    // predicate would let a bug hide from its own detector) but to the same test.
    const HEAT_ANYWHERE =
      /\b(bak\w*|roast\w*|grill\w*|boil\w*|simmer\w*|braise\w*|steam\w*|sear\w*|saut\w*|fry\w*|cook\w*|smok\w*|broil\w*|poach\w*|toast\w*|reduc\w*|char\w*|caramel\w*|melt\w*)\b/;
    if (gerund === "cooks" && NON_HEAT_OPENERS.some((v) => wtext.startsWith(v)) && !HEAT_ANYWHERE.test(wtext)) {
      hit("K-R3", plan.planId, label, `"cooks" but the window step is not heat: "${s.cue}" (window step: "${w.text.slice(0, 70)}")`);
    }
    // 4. "rests" when the window step is a marinate/soak/chill, not a rest.
    if (gerund === "rests" && /marinat|soak|brine|chill|refrigerat/.test(wtext)) {
      hit("K-R3", plan.planId, label, `"rests" but the window step is a marinate/soak: "${s.cue}" (window step: "${w.text.slice(0, 70)}")`);
    }
    // 5. GRAMMAR — a plural dish title with a singular verb.
    //
    // ⚠️ ONLY THE "While the X <verb>s" FORM CAN HAVE THIS DEFECT. The
    // participial "With the X cooking" carries no agreement at all, which is the
    // whole reason ruling 2 chose it, so firing this arm on it reported 76 false
    // positives — a fix counted as the bug it fixed. Gated on the wording the
    // cue actually used, not on the title alone.
    const usesFiniteVerb = /^While the /.test(s.cue);
    const last = wt.split(/\s+/).pop() ?? "";
    if (usesFiniteVerb && last.endsWith("s") && !SINGULAR_S.has(last) && !last.endsWith("ss")) {
      hit("K-R3", plan.planId, label, `plural dish title with a singular verb: "${s.cue}"`);
    }
  }

  // ── K-R4 — no action repeated across dishes ──────────────────────────────
  const STOP = new Set(["the", "a", "an", "and", "to", "of", "in", "on", "with", "for", "at", "into", "until", "then", "over", "about", "each", "all", "your"]);
  const bag = (t: string) => new Set(norm(t).replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
  const leadVerb = (t: string) => norm(t).replace(/[^a-z ]/g, " ").trim().split(/\s+/)[0] ?? "";
  for (let i = 0; i < meal.steps.length; i++) {
    for (let j = i + 1; j < meal.steps.length; j++) {
      const a = meal.steps[i], b = meal.steps[j];
      if (a.dishId === b.dishId) continue;
      bump("K-R4");
      const A = bag(a.text), B = bag(b.text);
      const inter = [...A].filter((w) => B.has(w)).length;
      const jac = inter / Math.max(1, new Set([...A, ...B]).size);
      if (jac >= 0.6 && leadVerb(a.text) === leadVerb(b.text)) {
        hit("K-R4", plan.planId, label,
          `duplicate action across dishes (${Math.round(jac * 100)}% overlap): "${a.dishTitle}" #${a.sequenceIndex + 1} "${a.text.slice(0, 70)}" ∥ "${b.dishTitle}" #${b.sequenceIndex + 1} "${b.text.slice(0, 70)}"`);
      }
    }
  }
  // The cross-reference form: a step that defers to another dish by name.
  for (const s of meal.steps) {
    const m = /\(see ([^)]+?) dish\)|see the ([^)]+?) dish/i.exec(s.text);
    if (m) {
      hit("K-R4", plan.planId, label,
        `cross-dish reference inside a step (the other dish's steps are already in the flow): "${s.dishTitle}" #${s.sequenceIndex + 1} "${s.text.slice(0, 90)}"`);
    }
  }

  // ── K-R5 — a passive wait ≥ 10 min is filled with available prep ──────────
  for (const w of meal.steps) {
    if (!isUnattended(w) || w.estimatedMinutes < 10 || w.startOffsetMinutes == null) continue;
    bump("K-R5");
    const ws = w.startOffsetMinutes, wf = finishOf(w);
    // Attended minutes actually scheduled inside the window.
    let filled = 0;
    for (const o of meal.steps) {
      if (o === w || isUnattended(o) || o.startOffsetMinutes == null) continue;
      const lo = Math.max(ws, o.startOffsetMinutes), hi = Math.min(wf, finishOf(o));
      if (hi > lo) filled += hi - lo;
    }
    // Was there prep that COULD have moved in? An attended step scheduled after
    // the window whose own dish-predecessors were all done before it started.
    const slicesByDish = slices;
    const movable = meal.steps.filter((o) => {
      if (isUnattended(o) || o.startOffsetMinutes == null || o.startOffsetMinutes < wf) return false;
      const sl = slicesByDish.get(o.dishId) ?? [];
      const k = sl.indexOf(o);
      return sl.slice(0, k).every((p) => p.startOffsetMinutes != null && finishOf(p) <= ws);
    });
    const idle = wf - ws - filled;
    if (idle > 5 && movable.length > 0) {
      hit("K-R5", plan.planId, label,
        `${w.dishTitle}: ${w.estimatedMinutes}-min ${w.phaseType} window (T${ws}..T${wf}) is ${idle} min idle while ${movable.length} later prep step(s) were already startable — e.g. "${movable[0].dishTitle}: ${movable[0].text.slice(0, 60)}"`);
    }
  }

  // ── K-R6 — Cook Mode's total vs the card's ────────────────────────────────
  //
  // TWO PAIRS, and only one of them is the one the browser pass saw.
  //
  // (a) THE FOOTER. Cook Mode's own header number is not the scheduler's: the
  //     screen calls `remainingMinutes(activeSteps, 0)` (lib/cooking/
  //     stepTiming.ts), a flat Σ estimatedMinutes over the sequenced steps. It
  //     therefore ignores every overlap rule the schedule was built from and
  //     reads far LONGER than the wall-clock the same steps describe. This is
  //     the 116-vs-88 the browser pass reported.
  // (b) THE STAMP. `Meal.estimatedTimeMinutes` and the live sequence both come
  //     off cookingScheduler, so they agree unless the stamp is stale.
  bump("K-R6");
  // ⚠️ THE Σ-STEP-MINUTES GAP IS NOT A FINDING ANY MORE, and keeping it as one
  // was wrong. Σ step minutes vs the schedule is a property of the DATA — a
  // multi-dish meal overlaps, so the sum is always larger — and it will never be
  // zero. What K-R6 asks is whether a USER is shown two numbers, and since
  // D-WS9-297 ruling 5 the footer reads `startOffsetMinutes` and the sum is shown
  // nowhere. Reported as context (the gap the footer used to leak) but not counted.
  const footerSerial = meal.steps.reduce((s, x) => s + x.estimatedMinutes, 0);
  context.push({
    plan: plan.planId,
    label,
    serialSum: footerSerial,
    schedule: meal.sequenceTotalMinutes,
    card: meal.cardTotalMinutes,
  });
  if (meal.sequenceTotalMinutes !== meal.cardTotalMinutes) {
    const why =
      meal.derivedTotalMinutes === meal.sequenceTotalMinutes
        ? "the stored stamp is STALE (a fresh derive reproduces Cook Mode)"
        : `a fresh derive gives ${meal.derivedTotalMinutes} — neither number`;
    hit("K-R6", plan.planId, label,
      `Cook Mode ${meal.sequenceTotalMinutes} min vs card ${meal.cardTotalMinutes} min (Δ${meal.sequenceTotalMinutes - meal.cardTotalMinutes}); ${why}${meal.cardActiveMinutes === meal.cardTotalMinutes ? "" : `; card-active ${meal.cardActiveMinutes}`}`);
  }
}

// ── P-R1 … P-R6 ─────────────────────────────────────────────────────────────

/** "1 ½ tbsp" / "¾ cup" / "2 cloves" → { qty, unit }. null when unparseable. */
const GLYPH: Record<string, number> = { "⅛": .125, "¼": .25, "⅓": 1 / 3, "⅜": .375, "½": .5, "⅝": .625, "⅔": 2 / 3, "¾": .75, "⅞": .875 };
function parseAmount(a: string): { qty: number; unit: string } | null {
  const m = /^\s*(?:(\d+)\s*)?([⅛¼⅓⅜½⅝⅔¾⅞])?\s*(?:(\d*\.?\d+)\s*)?(.*)$/.exec(a.trim());
  if (!m) return null;
  const [, whole, glyph, dec, rest] = m;
  let q = 0;
  if (whole) q += Number(whole);
  if (glyph) q += GLYPH[glyph];
  if (dec && !whole) q += Number(dec);
  if (q === 0 && !glyph) return null;
  return { qty: q, unit: norm(rest) };
}
const TBSP_PER: Record<string, number> = { tsp: 1 / 3, teaspoon: 1 / 3, tbsp: 1, tablespoon: 1, cup: 16, oz: 2, "fl oz": 2 };

function checkPrep(plan: PlanRecord, narration: NarrationInput | null) {
  if (!plan.prep) return;
  const P = plan.planId.slice(0, 8);
  const steps = plan.prep.steps;

  // The prep day. No column stores it: prep runs before the plan, so the plan's
  // own start is the only baseline the data offers. Stated, not assumed silently.
  const dates = Object.values(plan.dayByMealId).map((d) => d.date).filter((d): d is string => !!d).sort();
  const prepDay = plan.startDate ?? dates[0] ?? null;

  // ── P-R1 — containers per plan, portions per container ───────────────────
  if (narration) {
    let containers = 0;
    const tiny: string[] = [];
    for (const st of narration.steps) {
      if (st.isBlend) {
        // A blend is ONE container per dish (the prompt's own framing).
        const dishes = new Set(st.components.flatMap((c) => c.measures.map((m) => m.forDish)));
        containers += dishes.size;
        for (const d of dishes) {
          const mine = st.components.flatMap((c) => c.measures.filter((m) => m.forDish === d).map((m) => ({ c, m })));
          if (mine.length === 1) {
            const p = parseAmount(mine[0].m.amount);
            const tb = p && TBSP_PER[p.unit] != null ? p.qty * TBSP_PER[p.unit] : null;
            if (tb != null && tb < 1) tiny.push(`${mine[0].m.amount} ${mine[0].c.ingredientName} (blend of one, for ${d})`);
          }
        }
      } else {
        // Every other step: one container per (ingredient, dish) portion.
        for (const c of st.components) {
          const dishes = new Set(c.measures.map((m) => m.forDish));
          containers += dishes.size;
          for (const d of dishes) {
            const ms = c.measures.filter((m) => m.forDish === d);
            if (ms.length !== 1) continue;
            const p = parseAmount(ms[0].amount);
            const tb = p && TBSP_PER[p.unit] != null ? p.qty * TBSP_PER[p.unit] : null;
            if (tb != null && tb < 1) tiny.push(`${ms[0].amount} ${c.ingredientName} (for ${d})`);
          }
        }
      }
    }
    bump("P-R1");
    hit("P-R1", plan.planId, `${P} · ${plan.mealCount} meals`,
      `${containers} containers across ${narration.steps.length} steps (${(containers / Math.max(1, plan.mealCount)).toFixed(1)} per meal); ${tiny.length} hold a single ingredient under 1 tbsp — e.g. ${tiny.slice(0, 3).map((t) => `"${t}"`).join(", ")}`);
  }
  // The rendered text's own container count, as a second, independent read.
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  let textContainers = 0;
  for (const s of steps) {
    const re = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:small\s+|separate\s+)*(container|containers|bowl|bowls|jar|jars|bag|bags|cup|cups)\b/gi;
    for (const m of s.instructions.matchAll(re)) {
      const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (Number.isFinite(n)) textContainers += n;
    }
  }
  if (textContainers > 0) {
    hit("P-R1", plan.planId, `${P} · rendered text`, `the prose itself asks for ${textContainers} containers explicitly ("get out N containers")`);
  }

  // ── P-R2 — one named bowl per component across phases ────────────────────
  //
  // 🔴 THE FIRST VERSION OF THIS CHECK WAS TOO NARROW AND REPORTED 0. It tested
  // only the seasonings_dry ∩ sauces_marinades pair, because that is the pair
  // `blendSpiceDish` links. But `combinePrep` groups by ingredientId and
  // `assignPhase` routes by Ingredient.category, so a marinade's orange juice
  // and lime juice land in `produce` — and `blendSpiceDish` is set only on a
  // `sauces_marinades` step, so for those the link never fires at all. The real
  // split is across ANY number of steps in ANY phases.
  //
  // A "component" is approximated by the DISH, which is as fine as the data
  // gets: nothing in the prep pipeline models a component. That absence is the
  // finding, so the count below is "how many steps does one dish's prep end up
  // scattered over", and the join column is how many of those the prose ties
  // together.
  if (narration) {
    const dishSteps = new Map<string, { phase: string; ings: string[] }[]>();
    const dishLinked = new Set<string>();
    for (const st of narration.steps) {
      const perDish = new Map<string, string[]>();
      for (const c of st.components) {
        for (const m of c.measures) {
          const l = perDish.get(m.forDish) ?? [];
          if (!l.includes(c.ingredientName)) l.push(c.ingredientName);
          perDish.set(m.forDish, l);
        }
      }
      for (const [dish, ings] of perDish) {
        const l = dishSteps.get(dish) ?? [];
        l.push({ phase: st.phase, ings });
        dishSteps.set(dish, l);
      }
      if (st.blendSpiceDish) dishLinked.add(st.blendSpiceDish);
    }
    for (const [dish, sts] of dishSteps) {
      // A protein-only step is a portioning act, not a component pile.
      const piles = sts.filter((s) => s.phase !== "proteins");
      if (piles.length < 2) continue;
      bump("P-R2");
      const joined = dishLinked.has(dish);
      hit("P-R2", plan.planId, `${P} · ${dish.slice(0, 44)}`,
        `${piles.length} separate piles across ${new Set(piles.map((s) => s.phase)).size} phase(s)${joined ? ", ONE joined by the blendSpiceDish sentence" : ", NO join anywhere"} — ${piles.map((s) => `${s.phase}:{${s.ings.join("+")}}`).join(" | ").slice(0, 220)}`);
    }
  }
  // Does any step name a bowl at all (D-WS9-296's target state)?
  const named = steps.filter((s) => /\b(bowl|jar)\b/i.test(s.instructions) && /\b(the|your)\s+[A-Z]/.test(s.instructions)).length;
  hit("P-R2", plan.planId, `${P} · naming`, `${named}/${steps.length} steps name a destination bowl; D-WS9-296 requires every prep portion to name one`);

  // ── P-R3 — storage window vs cook day ────────────────────────────────────
  for (const s of steps) {
    if (!s.rendered || !s.storageNote || !prepDay) continue;
    const m = /up to (\d+|a|one|two|three|four|five|six|seven)\s*(day|days|week|weeks|month|months)/i.exec(s.storageNote);
    if (!m) continue;
    const WORDS2: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = WORDS2[m[1].toLowerCase()] ?? Number(m[1]);
    const mult = /week/i.test(m[2]) ? 7 : /month/i.test(m[2]) ? 30 : 1;
    const windowDays = n * mult;
    const cookDates = s.contributesToMealIds
      .map((id) => plan.dayByMealId[id]?.date)
      .filter((d): d is string => !!d);
    if (cookDates.length === 0) continue;
    bump("P-R3");
    const latest = cookDates.sort().at(-1)!;
    const lag = Math.round((Date.parse(latest) - Date.parse(prepDay)) / 86400000);
    if (lag > windowDays) {
      // P1 = the step's OWN object is raw flesh. Scanning the whole blob tagged
      // "Slice the red bell peppers for Sheet-Pan Chicken Fajitas" as protein
      // because the DESTINATION DISH is named in the title; the object is the
      // part before " for ".
      const object = norm(s.title.split(/\bfor\b/)[0]);
      const p1 = s.phase === "proteins" || RAW_PROTEIN_RE.test(object);
      hit("P-R3", plan.planId, `${P} · ${p1 ? "P1 " : ""}${s.title.slice(0, 50)}`,
        `storage "${windowDays} day${windowDays === 1 ? "" : "s"}" but the cook day is ${lag} days after prep (${prepDay} → ${latest})${p1 ? "  ⚠ RAW PROTEIN" : ""}`);
    }
  }

  // ── P-R4 — "do not prep ahead" inside a prep step ─────────────────────────
  //
  // ⚠️ NARROWED ON PURPOSE. The first pass matched any "on cook day" and
  // over-fired: "Pre-measure the spices so they're ready to stir in on cook
  // day" is a correct forward reference, not a self-contradiction. Only the
  // PROHIBITIONS count — a step that instructs the action and then forbids
  // doing it now.
  const DONT = /\bdo not (?:cut|prep|slice|chop|halve|dice|peel|mash|make|assemble|open)[^.]{0,60}?(?:ahead|early|until cook day)|\bdon'?t (?:cut|prep|slice|chop|halve|dice|peel|mash) [^.]{0,60}?(?:ahead|early)|\bkeep (?:them |it |these )?whole until cook day|\b(?:cut|prep|slice|chop|halve|dice|peel|mash)[^.]{0,40}?\bjust before\b[^.]{0,40}?(?:serving|making|cooking|baking|assembling)|\bnot ahead of time\b/i;
  for (const s of steps) {
    bump("P-R4");
    const blob = `${s.title}\n${s.instructions}`;
    const m = DONT.exec(blob);
    if (m) {
      hit("P-R4", plan.planId, `${P} · ${s.title.slice(0, 50)}`,
        `${s.rendered ? "RENDERED" : "render-omitted"} prep step that tells you not to prep it: "…${m[0].trim()}…" — full: "${s.instructions.slice(0, 120).replace(/\n/g, " ")}"`);
    }
  }

  // ── P-R5 — glyphs and natural counts ─────────────────────────────────────
  for (const s of steps) {
    if (!s.rendered) continue;
    bump("P-R5");
    const blob = `${s.title}\n${s.instructions}`;
    // ⚠️ A PACK SIZE IS NOT A QUANTITY. "1 can (14.9 oz) Guinness stout" prints
    // the container's own printed size, not a number the cook measures, and after
    // ruling 7 it was the single surviving P-R5 hit. A decimal inside parentheses
    // immediately before a unit is a pack size; its offset is skipped below.
    const packSizeAt = new Set<number>();
    for (const m of blob.matchAll(/\(\s*(\d+\.\d+)\s*(?:oz|fl oz|lb|g|kg|ml|l)\b/gi)) {
      if (m.index !== undefined) packSizeAt.add(m.index + m[0].indexOf(m[1]));
    }
    // A bare decimal quantity. Excludes temperatures, ranges and "1.5-inch".
    for (const m of blob.matchAll(/(?<![\d.])(\d+\.\d+)(?!\d*\s*(?:°|inch|in\b|cm|%))/g)) {
      if (m.index !== undefined && packSizeAt.has(m.index)) continue;
      hit("P-R5", plan.planId, `${P} · ${s.title.slice(0, 40)}`, `decimal quantity "${m[1]}" in: "${blob.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\n/g, " ")}"`);
    }
    // "each" used as a unit.
    for (const m of blob.matchAll(/(?<=[\d⅛¼⅓⅜½⅝⅔¾⅞]\s)each\b/g)) {
      hit("P-R5", plan.planId, `${P} · ${s.title.slice(0, 40)}`, `"each" printed as a unit: "${blob.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\n/g, " ")}"`);
    }
    // A SPACED mixed number. lib/format/quantity.formatQuantity writes "1½";
    // prepWeekAssembly.toEighths writes "1 ½". Two renderers, one app.
    for (const m of blob.matchAll(/\b(\d+) ([⅛¼⅓⅜½⅝⅔¾⅞])/g)) {
      hit("P-R5", plan.planId, `${P} · ${s.title.slice(0, 40)}`, `spaced mixed number "${m[1]} ${m[2]}" — the rest of the app writes "${m[1]}${m[2]}"`);
    }
  }

  // ── P-R6 — each citrus counted once ──────────────────────────────────────
  for (const fruit of CITRUS) {
    const whole = steps.filter((s) => s.rendered && new RegExp(`\\b${fruit}s?\\b`, "i").test(`${s.title} ${s.instructions}`) &&
      !new RegExp(`${fruit}\\s+(juice|zest)`, "i").test(`${s.title} ${s.instructions}`));
    const juice = steps.filter((s) => s.rendered && new RegExp(`${fruit}\\s+juice`, "i").test(`${s.title} ${s.instructions}`));
    if (whole.length === 0 || juice.length === 0) continue;
    bump("P-R6");
    const jTxt = juice[0].instructions.replace(/\n/g, " ");
    // Does the juice step ever say how many fruit it needs?
    const saysCount = new RegExp(`\\d[^.]{0,30}\\b${fruit}s?\\b`, "i").test(jTxt);
    hit("P-R6", plan.planId, `${P} · ${fruit}`,
      `counted in ${whole.length} whole-fruit step(s) ("${whole[0].title.slice(0, 45)}") AND measured as juice in ${juice.length} step(s) ("${juice[0].title.slice(0, 45)}")${saysCount ? "" : " — the juice step never says how many fruit it needs"}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const files = readdirSync(OUT).filter((f) => f.startsWith(`${TAG}__`) && f.endsWith(".json") && !f.includes("summary") && !f.includes("narration-input") && !f.includes("__check"));
  const plans: PlanRecord[] = files.map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")));

  for (const plan of plans) {
    let narration: NarrationInput | null = null;
    try {
      narration = JSON.parse(readFileSync(join(OUT, `${TAG}__${plan.planId.slice(0, 8)}__narration-input.json`), "utf8"));
    } catch { /* prep may have failed for this plan */ }
    for (const meal of plan.meals) checkCookMeal(plan, meal);
    checkPrep(plan, narration);
  }

  const RULES = ["K-R1", "K-R2", "K-R3", "K-R4", "K-R5", "K-R6", "P-R1", "P-R2", "P-R3", "P-R4", "P-R5", "P-R6"];
  const L: string[] = [];
  L.push(`THE PREP & COOK CENSUS — checker, tag=${TAG}`);
  L.push(`${plans.length} plans · ${plans.reduce((s, p) => s + p.meals.length, 0)} meals · ${plans.reduce((s, p) => s + (p.prep?.steps.length ?? 0), 0)} prep steps · ${plans.reduce((s, p) => s + p.meals.reduce((t, m) => t + m.steps.length, 0), 0)} cook steps`);
  L.push("");
  L.push("| rule | hits | of | plans affected |");
  L.push("|---|---|---|---|");
  for (const r of RULES) {
    const f = findings.filter((x) => x.rule === r);
    L.push(`| ${r} | ${f.length} | ${denom[r] ?? 0} | ${new Set(f.map((x) => x.plan)).size}/${plans.length} |`);
  }
  for (const r of RULES) {
    const f = findings.filter((x) => x.rule === r);
    L.push("");
    L.push(`── ${r} — ${f.length} finding(s) over ${denom[r] ?? 0} candidate(s) ${"─".repeat(30)}`);
    // Spread the examples over distinct plans so one bad plan can't fill them.
    const byPlan = new Map<string, Finding[]>();
    for (const x of f) { const l = byPlan.get(x.plan) ?? []; l.push(x); byPlan.set(x.plan, l); }
    const picked: Finding[] = [];
    let round = 0;
    while (picked.length < Math.min(EXAMPLES, f.length)) {
      let added = false;
      for (const l of byPlan.values()) if (l[round] && picked.length < EXAMPLES) { picked.push(l[round]); added = true; }
      if (!added) break;
      round++;
    }
    for (const x of picked) L.push(`  • [${x.where}] ${x.detail}`);
  }
  const text = L.join("\n");
  writeFileSync(join(OUT, `${TAG}__check.txt`), text);
  writeFileSync(join(OUT, `${TAG}__check.json`), JSON.stringify({ tag: TAG, denom, findings }, null, 2));
  console.log(text);
}

main();
