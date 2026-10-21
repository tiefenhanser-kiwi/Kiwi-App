// THX-3b (BUG-457) — ONE OVEN TEMPERATURE AFTER THE BIRD, IN THE CONTENT.
//
// The scheduler's oven (THX-3 B, planOven) frees when the bird comes out, and then
// every side bakes in it at once — but it does not know temperature. Make-Ahead's
// Thursday preheated the potato casserole to 350°F and the stuffing to 375°F six
// minutes apart and baked them together in one oven. The fix is the recipes', not the
// scheduler's: the sides that share the oven after the bird bake at ONE temperature,
// with their times adjusted to match.
//
//   • The temperature: the one holding the most post-bird oven minutes (ties: the
//     lower). A side already at it is untouched.
//   • A side moved by MORE than 25°F is REFUSED — past that the change is no longer
//     only a time change (browning, crisping), and a person decides.
//   • The time: about 10% longer per 25°F cooler (shorter hotter), the usual
//     baker's rule. Each "N minutes" in the side's Thursday oven steps moves; a range
//     keeps its width ("20–25" stays a five-minute window); ≥ 10 minutes rounds to 5.
//     The step's estimatedMinutes moves by what its upper bounds moved.
//
// Pure: the dry run prints it and --apply writes it (patch.ts), so production gets it
// with no AI. New generations get the same rule from FINALIZE_RULES (g).
import {
  holdCoveredText,
  isOvenStep,
  mergeFeastPreheats,
  ovenTempOfText,
  planOven,
  planOvenBlocks,
  reheatText,
  REHEAT_MINUTES,
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "../../src/lib/cookingScheduler";
import { onTheDaySteps } from "../../src/lib/mealTiming";

export const RETIME_PER_25F = 0.1;
export const MAX_SHIFT_F = 25;

export interface OvenStepRow {
  ownerId: string;
  stepIndex: number;
  stepTextTranslated: string;
  phaseType: string;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
}

export interface OvenDish {
  dishId: string;
  title: string;
  positionIndex: number;
  roleLabel?: string | null;
}

/** Thursday's Cook Mode for a feast from rows in memory — cookingSequence's own reading. */
export function thursdaySchedule(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]) {
  const schedulerDishes: SchedulerDish[] = [...dishes]
    .sort((a, b) => a.positionIndex - b.positionIndex)
    .map((d) => {
      const own = steps.filter((s) => s.ownerId === d.dishId).sort((a, b) => a.stepIndex - b.stepIndex);
      return {
        dishId: d.dishId,
        title: d.title,
        positionIndex: d.positionIndex,
        roleLabel: d.roleLabel ?? null,
        steps: onTheDaySteps(own.map((s) => ({ ...s, text: s.stepTextTranslated }))).map((s) => ({
          stepIndex: s.stepIndex,
          estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
          phaseType: s.phaseType as SchedulerPhase,
          isTimingSensitive: s.isTimingSensitive,
          text: s.stepTextTranslated,
          parallelGroup: s.parallelGroup,
          componentKey: s.componentKey,
          pathKey: s.pathKey,
        })),
      };
    })
    .filter((d) => d.steps.length > 0);
  return { schedulerDishes, result: scheduleCookingSequence(schedulerDishes, { feastOven: true }) };
}

/** An oven temperature a step names (250–550°F); an internal temperature (165°F) is not one. */
export function ovenTempOf(text: string): number | null {
  for (const m of text.matchAll(/(\d{3})\s*°\s*F/g)) {
    const t = Number(m[1]);
    if (t >= 250 && t <= 550) return t;
  }
  return null;
}

export interface OvenLine {
  dishId: string;
  title: string;
  stepIndex: number;
  /** The step's own temperature, or the dish's last one before it that day. */
  temp: number | null;
  start: number;
  end: number;
  holder: boolean;
  /** Starts once the bird is out of the oven. */
  afterBird: boolean;
}

export interface OvenReport {
  holderTitle: string | null;
  ovenOut: number | null;
  total: number;
  lines: OvenLine[];
  /** The bird: its rest's end and the carve's start (the hold between them). */
  bird: { restEnd: number; carveStart: number } | null;
}

export function ovenReport(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): OvenReport {
  const { schedulerDishes, result } = thursdaySchedule(dishes, steps);
  const plan = planOven(schedulerDishes);
  const at = new Map(result.steps.map((s) => [`${s.dishId}|${s.originalStepIndex}`, s.startOffsetMinutes]));
  let ovenOut: number | null = null;
  let bird: OvenReport["bird"] = null;
  if (plan) {
    const hd = schedulerDishes.find((d) => d.dishId === plan.holderDishId)!;
    const last = hd.steps[plan.holderLastOven];
    ovenOut = (at.get(`${hd.dishId}|${last.stepIndex}`) ?? 0) + last.estimatedMinutes;
    const rest = hd.steps.findIndex((s, i) => i > plan.holderLastOven && s.phaseType === "rest");
    if (rest >= 0 && rest + 1 < hd.steps.length) {
      const r = hd.steps[rest];
      bird = { restEnd: (at.get(`${hd.dishId}|${r.stepIndex}`) ?? 0) + r.estimatedMinutes, carveStart: at.get(`${hd.dishId}|${hd.steps[rest + 1].stepIndex}`) ?? 0 };
    }
  }
  const lines: OvenLine[] = [];
  for (const d of schedulerDishes) {
    let temp: number | null = null;
    for (const s of d.steps) {
      const own = ovenTempOf(s.text ?? "");
      if (!isOvenStep(s)) continue;
      if (own !== null) temp = own;
      // THX-3c — a preheat the scheduler merged into another dish's is not on Thursday.
      if (!at.has(`${d.dishId}|${s.stepIndex}`)) continue;
      const start = at.get(`${d.dishId}|${s.stepIndex}`)!;
      const holder = plan?.holderDishId === d.dishId;
      lines.push({ dishId: d.dishId, title: d.title, stepIndex: s.stepIndex, temp, start, end: start + s.estimatedMinutes, holder, afterBird: !holder && ovenOut !== null && start >= ovenOut });
    }
  }
  lines.sort((a, b) => a.start - b.start || a.end - b.end);
  const holderTitle = plan ? schedulerDishes.find((d) => d.dishId === plan.holderDishId)!.title : null;
  return { holderTitle, ovenOut, total: result.totalEstimatedMinutes, lines, bird };
}

/** One printed line per oven step: "  T-92→-77  350°F  Mashed Potato Casserole #3 (after the bird)". */
export function formatOvenReport(r: OvenReport): string[] {
  const out = [r.holderTitle ? `oven: ${r.holderTitle} holds it until T${r.ovenOut}` : "oven: no dish roasts long enough to hold it (no bird) — every oven step listed"];
  for (const l of r.lines) {
    out.push(`    T${String(l.start).padStart(5)}→${String(l.end).padStart(4)}  ${l.temp !== null ? `${l.temp}°F` : "  ?  "}  ${l.title.slice(0, 40)} #${l.stepIndex}${l.holder ? " (the bird)" : l.afterBird ? " (after the bird)" : ""}`);
  }
  if (r.bird) out.push(`    the bird rests until T${r.bird.restEnd}; carving starts T${r.bird.carveStart} — a ${r.bird.carveStart - r.bird.restEnd} min hold`);
  for (const c of ovenConflicts(r)) out.push(`    CONFLICT ${c}`);
  return out;
}

/**
 * THX-3c (BUG-463) — every pair of oven steps that overlap at two temperatures,
 * as printed lines. Empty when the oven runs one temperature at a time.
 */
export function ovenConflicts(r: OvenReport): string[] {
  const out: string[] = [];
  const ls = r.lines.filter((l) => l.temp !== null);
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i], b = ls[j];
      if (a.temp === b.temp || a.dishId === b.dishId) continue;
      if (a.start < b.end && b.start < a.end) out.push(`T${a.start}→${a.end} ${a.temp}°F ${a.title.slice(0, 30)} #${a.stepIndex} overlaps T${b.start}→${b.end} ${b.temp}°F ${b.title.slice(0, 30)} #${b.stepIndex}`);
    }
  }
  return out;
}

export interface OvenChange { dishId: string; title: string; from: number; to: number }
export interface OvenPlanOut { target: number | null; changes: OvenChange[]; refused: OvenChange[] }

/** The one post-bird temperature, and which sides move to it. */
export function oneOvenTemperature(r: OvenReport): OvenPlanOut {
  const post = r.lines.filter((l) => l.afterBird && l.temp !== null);
  const minutes = new Map<number, number>();
  for (const l of post) minutes.set(l.temp!, (minutes.get(l.temp!) ?? 0) + (l.end - l.start));
  if (minutes.size <= 1) return { target: post[0]?.temp ?? null, changes: [], refused: [] };
  const target = [...minutes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const changes: OvenChange[] = [];
  const refused: OvenChange[] = [];
  const seen = new Set<string>();
  for (const l of post) {
    if (l.temp === target || seen.has(l.dishId)) continue;
    seen.add(l.dishId);
    const c = { dishId: l.dishId, title: l.title, from: l.temp!, to: target };
    (Math.abs(c.from - c.to) > MAX_SHIFT_F ? refused : changes).push(c);
  }
  return { target, changes, refused };
}

const round5 = (n: number) => (n >= 10 ? Math.round(n / 5) * 5 : Math.round(n));

/**
 * One oven step's text moved from `from`°F to `to`°F: the temperature replaced, every
 * "N minutes" (or "N–M minutes") scaled by the baker's rule. `extraMinutes` is what the
 * upper bounds moved, for the step's estimatedMinutes.
 */
export function retimeForTemp(text: string, from: number, to: number): { text: string; extraMinutes: number } {
  const f = 1 + (RETIME_PER_25F * (from - to)) / 25;
  let extra = 0;
  const withTemp = text.replace(new RegExp(`\\b${from}(\\s*°\\s*F)`, "g"), `${to}$1`);
  const retimed = withTemp.replace(/\b(\d+)(\s*(?:–|-|to)\s*(\d+))?(\s*minutes?)\b/g, (_all, lo: string, range: string | undefined, hi: string | undefined, word: string) => {
    const a = Number(lo);
    const a2 = Math.max(1, round5(a * f));
    if (!range || !hi) {
      extra += a2 - a;
      return `${a2}${word}`;
    }
    const b = Number(hi);
    const b2 = a2 + (b - a);
    extra += b2 - b;
    return `${a2}${range.replace(hi, String(b2))}${word}`;
  });
  return { text: retimed, extraMinutes: extra };
}

/** Every Thursday oven step of one dish, retimed: stepIndex → its new text and minutes. */
export function retimeDish(steps: readonly OvenStepRow[], change: OvenChange): Map<number, { text: string; minutes: number }> {
  const own = steps.filter((s) => s.ownerId === change.dishId).sort((a, b) => a.stepIndex - b.stepIndex);
  const day = onTheDaySteps(own.map((s) => ({ ...s, text: s.stepTextTranslated })));
  const out = new Map<number, { text: string; minutes: number }>();
  for (const s of day) {
    if (!isOvenStep({ phaseType: s.phaseType as SchedulerPhase, text: s.text })) continue;
    const r = retimeForTemp(s.text, change.from, change.to);
    if (r.text !== s.text) out.set(s.stepIndex, { text: r.text, minutes: Math.max(1, s.estimatedMinutes + r.extraMinutes) });
  }
  return out;
}

// ── THX-3c — CODE-WRITTEN OVEN STEPS ───────────────────────────────────────────

/** A step patch.ts writes into a feast dish (never AI). */
export interface CodeStep {
  dishId: string;
  title: string;
  stepIndex: number;
  text: string;
  phaseType: SchedulerPhase;
  estimatedMinutes: number;
}

/**
 * THX-3c (BUG-463, chat-Claude's ruling) — a feast with no bird to hold its oven and
 * more than one temperature: each dish of an earlier block (it holds well covered)
 * gets two steps after its last oven step — cover it with foil, and return it
 * uncovered to the last block's oven for 10 minutes at serving time. Only for a dish
 * whose last step IS that oven step; idempotent (a dish with its reheat gets nothing).
 */
export function heldDishSteps(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): CodeStep[] {
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  const merged = mergeFeastPreheats(schedulerDishes).dishes;
  if (planOven(merged)) return [];
  const blocks = planOvenBlocks(merged);
  if (!blocks) return [];
  const last = Math.max(...blocks.blockOf.values());
  const lastTemp = merged
    .filter((d) => blocks.blockOf.get(d.dishId) === last)
    .flatMap((d) => d.steps.map((s) => ovenTempOfText(s.text)))
    .find((t): t is number => t !== null);
  if (lastTemp === undefined) return [];
  const out: CodeStep[] = [];
  for (const d of merged) {
    const b = blocks.blockOf.get(d.dishId);
    if (b === undefined || b === last || blocks.reheatOf.has(d.dishId)) continue;
    const lastIdx = d.steps.length - 1;
    if (!blocks.ovenSteps.get(d.dishId)?.has(lastIdx)) continue;
    const top = Math.max(...steps.filter((s) => s.ownerId === d.dishId).map((s) => s.stepIndex));
    out.push(
      { dishId: d.dishId, title: d.title, stepIndex: top + 1, text: holdCoveredText(d.title), phaseType: "assemble", estimatedMinutes: 1 },
      { dishId: d.dishId, title: d.title, stepIndex: top + 2, text: reheatText(d.title, lastTemp), phaseType: "cook", estimatedMinutes: REHEAT_MINUTES },
    );
  }
  return out;
}

/** The code-written raise step's words: "As the turkey comes out, raise the oven to 350°F for the sides." */
const RAISE_STEP = /\braise the oven to \d{3}\s*°\s*F\b/i;
export const RAISE_MINUTES = 5;

/**
 * THX-3c (item 3) — when the bird comes out and the next oven dish needs another
 * temperature with no preheat of its own (Classic: 325°F → 350°F), the bird's dish
 * gets a step right after its last oven step: "As the turkey comes out, raise the oven
 * to 350°F for the sides." Returns the step and the bird's later steps' new indexes
 * (each moves down one); null when nothing is needed or it is already there.
 */
export function raiseOvenStep(
  dishes: readonly OvenDish[],
  steps: readonly OvenStepRow[],
): { step: CodeStep; renumber: { dishId: string; from: number; to: number }[] } | null {
  const r = ovenReport(dishes, steps);
  const bird = r.lines.filter((l) => l.holder);
  if (bird.length === 0) return null;
  const birdId = bird[0].dishId;
  const own = steps.filter((s) => s.ownerId === birdId);
  if (own.some((s) => RAISE_STEP.test(s.stepTextTranslated))) return null;
  const birdTemp = [...bird].reverse().find((l) => l.temp !== null)?.temp ?? null;
  const after = r.lines.filter((l) => l.afterBird);
  const firstAfter = after[0];
  if (!firstAfter || firstAfter.temp === null || firstAfter.temp === birdTemp) return null;
  // A side that preheats to it itself (Make-Ahead's "Preheat the oven to 350°F") needs no raise.
  if (after.some((l) => l.temp === firstAfter.temp && steps.find((s) => s.ownerId === l.dishId && s.stepIndex === l.stepIndex)?.phaseType === "preheat")) return null;
  const lastOven = Math.max(...bird.map((l) => l.stepIndex));
  const title = dishes.find((d) => d.dishId === birdId)!.title;
  const noun = /\b(turkey|chicken|duck|goose|hen)\b/i.exec(title)?.[1]?.toLowerCase() ?? "roast";
  return {
    step: {
      dishId: birdId, title, stepIndex: lastOven + 1, phaseType: "preheat", estimatedMinutes: RAISE_MINUTES,
      text: `As the ${noun} comes out, raise the oven to ${firstAfter.temp}°F for the sides.`,
    },
    renumber: own.filter((s) => s.stepIndex > lastOven).sort((a, b) => b.stepIndex - a.stepIndex).map((s) => ({ dishId: birdId, from: s.stepIndex, to: s.stepIndex + 1 })),
  };
}


/** "Preheat the oven to 425°F. Season the caps…" — the preheat, then the work it carries. */
const PREHEAT_WITH_WORK = /^(\s*(?:On [A-Za-z]+day:\s*)?(?:Pre)?heat (?:the )?oven to \d{3}\s*°\s*F\.)\s+(\S.*)$/i;
export const SPLIT_WORK_MINUTES = 3;

/**
 * THX-3c (BUG-463) — a later oven block's preheat waits for the block before it and is
 * placed just before the bake it heats (cookingScheduler floating preheats), so it may
 * carry no work the dish needs earlier: the Wellington's "Preheat the oven to 425°F.
 * Season the 4 portobello caps…" is split into the preheat alone and the seasoning as
 * its own prep step right after it (the dish's later steps move down one, ids kept).
 */
export function splitPreheatSteps(
  dishes: readonly OvenDish[],
  steps: readonly OvenStepRow[],
): { preheat: { dishId: string; stepIndex: number; text: string }; work: CodeStep; renumber: { dishId: string; from: number; to: number }[] }[] {
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  if (planOven(schedulerDishes)) return [];
  const blocks = planOvenBlocks(schedulerDishes);
  if (!blocks) return [];
  const out: ReturnType<typeof splitPreheatSteps> = [];
  for (const d of schedulerDishes) {
    if ((blocks.blockOf.get(d.dishId) ?? 0) === 0) continue;
    for (const s of d.steps) {
      if (s.phaseType !== "preheat") continue;
      const m = PREHEAT_WITH_WORK.exec(s.text ?? "");
      if (!m) continue;
      const own = steps.filter((x) => x.ownerId === d.dishId);
      out.push({
        preheat: { dishId: d.dishId, stepIndex: s.stepIndex, text: m[1].trim() },
        work: { dishId: d.dishId, title: d.title, stepIndex: s.stepIndex + 1, text: m[2].trim(), phaseType: "prep", estimatedMinutes: SPLIT_WORK_MINUTES },
        renumber: own.filter((x) => x.stepIndex > s.stepIndex).sort((a, b) => b.stepIndex - a.stepIndex).map((x) => ({ dishId: d.dishId, from: x.stepIndex, to: x.stepIndex + 1 })),
      });
    }
  }
  return out;
}
