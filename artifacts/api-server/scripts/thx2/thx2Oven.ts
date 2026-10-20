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
import { isOvenStep, planOven, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../../src/lib/cookingScheduler";
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
      const start = at.get(`${d.dishId}|${s.stepIndex}`) ?? 0;
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
