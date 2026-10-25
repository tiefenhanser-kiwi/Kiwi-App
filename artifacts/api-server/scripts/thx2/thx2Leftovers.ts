// THX-3d round 4 (BUG-497) — two of round 3's leftovers that are words (content, patch.ts,
// no AI), read off the day scheduled again once everything else is written.
//
//   1. "reserve the pan drippings" stays only while a dish still takes them. Production's
//      New Twist carved its turkey at T−21 "…; reserve all pan drippings for the gravy"
//      and its gravy had poured them off at T−46. The clause goes from a bird step when
//      no other dish's step that works from the pan (the scheduler's DRIPPINGS) starts at
//      or after it. (Not "when no dish takes drippings" as proposed: every one of the five
//      has a gravy that does — that rule changes nothing, and New Twist's is stale.)
//   7. A carved bird that still waits more than CARVED_WAIT_MAX minutes for serving after
//      the scheduler has landed the carve as late as the cook's hands allow (carveLate) is
//      tented: the carve step gains " Tent loosely with foil." (and loses it when it no
//      longer waits). Idempotent.
import { CARVED_WAIT_MAX, DRIPPINGS, FEAST_SERVE_STEP, feastRoastDish } from "../../src/lib/cookingScheduler";
import { thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";

export const TENT = " Tent loosely with foil.";
/** A bird step's own "reserve the drippings" clause, in the three ways production writes it. */
const RESERVE = [
  /\s*;\s*reserve\b[^.;]*\bdrippings\b[^.;]*(?=[.;]|$)/i, // "…; reserve all pan drippings for the gravy."
  /\s*[—–]\s*reserve\b[^.;]*\bdrippings\b[^.;]*(?=[.;]|$)/i, // "… — reserve the drippings in the pan for gravy."
  /\s+Reserve\b[^.;]*\bdrippings\b[^.;]*\.(?=\s|$)/, // "…. Reserve the pan drippings for finishing the gravy."
];

/** The text without its reserve-the-drippings clause (null when it has none). */
export function withoutReserve(text: string): string | null {
  for (const re of RESERVE) if (re.test(text)) return text.replace(re, "").replace(/\s+\./g, ".").trim();
  return null;
}

/** The carve step with the tent sentence when the carved bird waits, without it when it does not. */
export function withTent(text: string, waits: boolean): string {
  const tented = text.endsWith(TENT.trim());
  if (waits && !tented) return `${text.replace(/\s+$/, "")}${TENT}`;
  if (!waits && tented) return text.slice(0, -TENT.trim().length).replace(/\s+$/, "");
  return text;
}

export function leftoverEdits(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): { dishId: string; stepIndex: number; text: string }[] {
  const { schedulerDishes, result } = thursdaySchedule(dishes, steps);
  const bird = feastRoastDish(schedulerDishes);
  if (!bird) return [];
  const d = schedulerDishes.find((x) => x.dishId === bird.dishId)!;
  const at = new Map(result.steps.map((e) => [`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes]));
  const out: { dishId: string; stepIndex: number; text: string }[] = [];
  // 1. the drippings — stale at the meal's own servings or at the fewest pans (a sheet
  // pan each, a 9×13 each: the order moves with the servings, the words are written once).
  const fewest = thursdaySchedule(dishes.map((x) => ({ ...x, ovenRacks: x.ovenVessel === "sheet" ? 1 : x.ovenRacks ? 0.5 : x.ovenRacks })), steps).result;
  const textOf = new Map<number, string>();
  for (const r of [result, fewest]) {
    const on = new Map(r.steps.map((e) => [`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes]));
    const takers = schedulerDishes.filter((x) => x.dishId !== d.dishId).flatMap((x) => x.steps.filter((s) => DRIPPINGS.test(s.text ?? "") && on.has(`${x.dishId}#${s.stepIndex}`)).map((s) => on.get(`${x.dishId}#${s.stepIndex}`)!));
    for (const s of d.steps) {
      const start = on.get(`${d.dishId}#${s.stepIndex}`);
      const bare = withoutReserve(s.text ?? "");
      if (start === undefined || bare === null || takers.some((t) => t >= start)) continue;
      textOf.set(s.stepIndex, bare);
    }
  }
  // 7. the carved bird's wait
  const rest = d.steps.findIndex((s, i) => i > bird.lastOven && s.phaseType === "rest");
  const carve = rest >= 0 ? d.steps.slice(rest + 1).find((s) => !FEAST_SERVE_STEP.test(s.text ?? "")) : undefined;
  const serve = d.steps.find((s) => FEAST_SERVE_STEP.test(s.text ?? ""));
  const carveAt = carve ? at.get(`${d.dishId}#${carve.stepIndex}`) : undefined;
  const serveAt = serve ? at.get(`${d.dishId}#${serve.stepIndex}`) : 0;
  if (carve && carveAt !== undefined && serveAt !== undefined) {
    const text = textOf.get(carve.stepIndex) ?? carve.text ?? "";
    const next = withTent(text, serveAt - (carveAt + carve.estimatedMinutes) > CARVED_WAIT_MAX);
    if (next !== text) textOf.set(carve.stepIndex, next);
  }
  for (const [stepIndex, text] of textOf) if (text !== d.steps.find((s) => s.stepIndex === stepIndex)?.text) out.push({ dishId: d.dishId, stepIndex, text });
  return out;
}
