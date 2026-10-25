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
  dishRacks,
  feastRoastDish,
  OVEN_RACKS,
  ovenStays,
  holdCoveredText,
  HOLD_COVERED_STEP,
  isReheatStep,
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
import { withSheetPanCount, type OvenVessel } from "../../src/lib/ovenRacks";

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
  /** THX-3d round 4 (BUG-496) — its racks in the oven (ovenRacks.ts), at the meal's own servings. */
  ovenRacks?: number | null;
  /** …and the vessel they are in: a sheet pan (roasted, best from the oven) or a dish (holds well, covered). */
  ovenVessel?: OvenVessel | null;
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
        ...(d.ovenRacks !== undefined && d.ovenRacks !== null ? { ovenRacks: d.ovenRacks } : {}),
        ...(d.ovenVessel ? { ovenVessel: d.ovenVessel } : {}),
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
  /** THX-3d round 4 (BUG-496) — every stay in the oven and the racks in use over the day. */
  racks: RackLedger;
}

export interface RackLedger {
  stays: { title: string; from: number; to: number; racks: number }[];
  /** The most racks in use at any minute. */
  max: number;
  /** The stretches above OVEN_RACKS, and their minutes summed. */
  over: { from: number; to: number; racks: number; titles: string[] }[];
  overMinutes: number;
}

/** THX-3d round 4 (A4) — the racks in use, minute by minute, off a feast's own schedule. */
export function rackLedger(schedulerDishes: readonly SchedulerDish[], result: { steps: { dishId: string; originalStepIndex: number; startOffsetMinutes: number }[] }): RackLedger {
  const at = new Map(result.steps.map((s) => [`${s.dishId}|${s.originalStepIndex}`, s.startOffsetMinutes]));
  const merged = mergeFeastPreheats(schedulerDishes).dishes;
  const bird = feastRoastDish(merged);
  const stays: RackLedger["stays"] = [];
  for (const d of merged) {
    const isBird = bird?.dishId === d.dishId;
    for (const s of ovenStays(d, isBird ? bird : null)) {
      const placed = d.steps.slice(s.from, s.to + 1).filter((x) => at.has(`${d.dishId}|${x.stepIndex}`));
      if (placed.length === 0) continue;
      const from = Math.min(...placed.map((x) => at.get(`${d.dishId}|${x.stepIndex}`)!));
      const to = Math.max(...placed.map((x) => at.get(`${d.dishId}|${x.stepIndex}`)! + x.estimatedMinutes));
      stays.push({ title: d.title, from, to, racks: dishRacks(d, isBird) });
    }
  }
  stays.sort((a, b) => a.from - b.from || a.to - b.to);
  const over: RackLedger["over"] = [];
  let max = 0;
  if (stays.length > 0) {
    const lo = Math.min(...stays.map((s) => s.from));
    const hi = Math.max(...stays.map((s) => s.to));
    for (let t = lo; t < hi; t++) {
      const inn = stays.filter((s) => s.from <= t && t < s.to);
      const r = inn.reduce((n, s) => n + s.racks, 0);
      max = Math.max(max, r);
      if (r <= OVEN_RACKS + 1e-9) continue;
      const titles = inn.map((s) => s.title);
      const last = over[over.length - 1];
      if (last && last.to === t && last.racks === r && last.titles.join("|") === titles.join("|")) last.to = t + 1;
      else over.push({ from: t, to: t + 1, racks: r, titles });
    }
  }
  return { stays, max, over, overMinutes: over.reduce((n, o) => n + o.to - o.from, 0) };
}

const half = (r: number) => (r === 0.5 ? "½" : Number.isInteger(r) ? String(r) : `${Math.floor(r)}½`);

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
  return { holderTitle, ovenOut, total: result.totalEstimatedMinutes, lines, bird, racks: rackLedger(schedulerDishes, result) };
}

/** One printed line per oven step: "  T-92→-77  350°F  Mashed Potato Casserole #3 (after the bird)". */
export function formatOvenReport(r: OvenReport): string[] {
  const out = [r.holderTitle ? `oven: ${r.holderTitle} holds it until T${r.ovenOut}` : "oven: no dish roasts long enough to hold it (no bird) — every oven step listed"];
  for (const l of r.lines) {
    out.push(`    T${String(l.start).padStart(5)}→${String(l.end).padStart(4)}  ${l.temp !== null ? `${l.temp}°F` : "  ?  "}  ${l.title.slice(0, 40)} #${l.stepIndex}${l.holder ? " (the bird)" : l.afterBird ? " (after the bird)" : ""}`);
  }
  if (r.bird) out.push(`    the bird rests until T${r.bird.restEnd}; carving starts T${r.bird.carveStart} — a ${r.bird.carveStart - r.bird.restEnd} min hold`);
  for (const c of ovenConflicts(r)) out.push(`    CONFLICT ${c}`);
  // THX-3d round 4 (A4) — the racks: each stay, the most in use, every minute over two.
  for (const s of r.racks.stays) out.push(`    rack  T${String(s.from).padStart(5)}→${String(s.to).padStart(4)}  ${half(s.racks).padStart(2)}  ${s.title.slice(0, 40)}`);
  out.push(`    racks: at most ${half(r.racks.max)} of ${OVEN_RACKS} · ${r.racks.overMinutes} minute(s) over capacity`);
  for (const o of r.racks.over) out.push(`    OVER CAPACITY T${o.from}→${o.to} ${half(o.racks)} racks: ${o.titles.join(" + ")}`);
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
 * uncovered to the last block's oven for 10 minutes at serving time. Idempotent (a
 * dish with its reheat gets nothing).
 *
 * THX-3d (R4) — also beside a BIRD hotter than its sides (New Twist: the spatchcock at
 * 425°F, its stuffing and potatoes at 350°F bake first), and right after the dish's
 * last OVEN step even when it is not the dish's last step (the stuffing's "Let it rest
 * 5 minutes", the potatoes' plating): its later steps move down two.
 */
export function heldDishSteps(
  dishes: readonly OvenDish[],
  steps: readonly OvenStepRow[],
): { creates: CodeStep[]; renumber: { dishId: string; from: number; to: number }[] } {
  const none = { creates: [], renumber: [] };
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  const merged = mergeFeastPreheats(schedulerDishes).dishes;
  if (planOven(merged)) return none;
  // THX-3d (R4) — a bird hotter than its sides is a block of its own, the last.
  const blocks = planOvenBlocks(merged, feastRoastDish(merged)?.dishId ?? null);
  if (!blocks) return none;
  const last = Math.max(...blocks.blockOf.values());
  const lastTemp = merged
    .filter((d) => blocks.blockOf.get(d.dishId) === last)
    .flatMap((d) => d.steps.map((s) => ovenTempOfText(s.text)))
    .find((t): t is number => t !== null);
  if (lastTemp === undefined) return none;
  const out: ReturnType<typeof heldDishSteps> = { creates: [], renumber: [] };
  // THX-3d round 5 (D-WS9-322) — the main dish finishes last among the oven dishes: in its
  // block, what does not fit beside it at the meal's own servings bakes before it, held
  // (Vegetarian at 10: two pans of sprouts beside the Wellington's pan).
  const inLast = merged.filter((d) => blocks.blockOf.get(d.dishId) === last);
  const main = inLast.find((d) => /\bmain\b/i.test(d.roleLabel ?? ""));
  const crowded = !!main && inLast.reduce((n, d) => n + dishRacks(d, false), 0) > OVEN_RACKS + 1e-9;
  for (const d of merged) {
    const b = blocks.blockOf.get(d.dishId);
    if (b === undefined || (b === last && (!crowded || d === main)) || blocks.reheatOf.has(d.dishId)) continue;
    const ov = [...(blocks.ovenSteps.get(d.dishId) ?? [])];
    if (ov.length === 0) continue;
    const at = d.steps[Math.max(...ov)].stepIndex;
    for (const s of steps.filter((x) => x.ownerId === d.dishId && x.stepIndex > at).sort((a, b) => b.stepIndex - a.stepIndex)) {
      out.renumber.push({ dishId: d.dishId, from: s.stepIndex, to: s.stepIndex + 2 });
    }
    out.creates.push(
      { dishId: d.dishId, title: d.title, stepIndex: at + 1, text: holdCoveredText(d.title), phaseType: "assemble", estimatedMinutes: 1 },
      { dishId: d.dishId, title: d.title, stepIndex: at + 2, text: reheatText(d.title, lastTemp), phaseType: "cook", estimatedMinutes: REHEAT_MINUTES },
    );
  }
  return out;
}

/**
 * THX-3d round 2 (O) — each hold step says "while the oven heats for the next dish" only
 * when the oven's temperature changes as the dish comes out: no other dish is baking at
 * its temperature then, and the next oven step to start is at another. Text updates for
 * the steps whose words disagree (idempotent).
 */
export function holdTextUpdates(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): { dishId: string; stepIndex: number; text: string }[] {
  const report = ovenReport(dishes, steps);
  const out: { dishId: string; stepIndex: number; text: string }[] = [];
  for (const s of steps) {
    const m = HOLD_COVERED_STEP.exec(s.stepTextTranslated.trim());
    if (!m) continue;
    const mine = report.lines.filter((l) => l.dishId === s.ownerId && l.stepIndex < s.stepIndex);
    const last = mine.sort((a, b) => b.end - a.end)[0];
    if (!last) continue;
    const others = report.lines.filter((l) => l.dishId !== s.ownerId && !isReheatStep({ text: steps.find((x) => x.ownerId === l.dishId && x.stepIndex === l.stepIndex)?.stepTextTranslated ?? "" }));
    const stillBaking = others.some((l) => l.start < last.end && last.end < l.end && l.temp === last.temp);
    const next = others.filter((l) => l.start >= last.end).sort((a, b) => a.start - b.start)[0];
    const changes = !stillBaking && !!next && next.temp !== null && next.temp !== last.temp;
    const want = holdCoveredText(m[1], changes);
    if (want !== s.stepTextTranslated.trim()) out.push({ dishId: s.ownerId, stepIndex: s.stepIndex, text: want });
  }
  return out;
}

/**
 * THX-3d round 4 (A1) — a side's sheet pans, as its day's steps count them, corrected to
 * what its pounds need at the meal's own servings ("Line two rimmed sheet pans" for 1¼ lb
 * → "Line a rimmed sheet pan"; 5 lb on "two" → "three"). Not the bird's pan. Idempotent.
 */
export function panCountEdits(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): { dishId: string; stepIndex: number; text: string }[] {
  const bird = feastRoastDish(thursdaySchedule(dishes, steps).schedulerDishes);
  const out: { dishId: string; stepIndex: number; text: string }[] = [];
  for (const d of dishes) {
    if (d.dishId === bird?.dishId || d.ovenVessel !== "sheet" || !d.ovenRacks) continue;
    const own = steps.filter((s) => s.ownerId === d.dishId).sort((a, b) => a.stepIndex - b.stepIndex);
    for (const s of onTheDaySteps(own.map((x) => ({ ...x, text: x.stepTextTranslated })))) {
      const next = withSheetPanCount(s.text, d.ovenRacks);
      if (next !== null) out.push({ dishId: d.dishId, stepIndex: s.stepIndex, text: next });
    }
  }
  return out;
}

/** The code-written raise step's minutes (THX-3d: "Raise the oven to 350°F and put in …", thx2Thursday). */
export const RAISE_MINUTES = 5;
/** THX-3d round 3 (T) — the code-written "Put the … in the oven with the turkey." step's minutes. */
export const PUT_IN_WITH_MINUTES = 2;

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
  const blocks = planOvenBlocks(schedulerDishes, feastRoastDish(schedulerDishes)?.dishId ?? null);
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
