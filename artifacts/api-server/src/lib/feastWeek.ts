// SERVER-8 A (BUG-567) — A FEAST ON ANY DAY.
//
// The Thanksgiving feasts are written for a Thursday. Their tags (`ahead-mon`,
// `brine-wed`) and step words ("Make ahead (Monday):", "Thaw (start Friday):",
// "refrigerate until Thursday") name the weekdays of a Thursday plan, and every one
// of them is really an OFFSET from the feast: Wednesday is the day before, Monday
// three days out, Friday six. Read against a feast on another weekday, the old
// arithmetic, (feast − day + 7) % 7 || 7, put a Wednesday feast's brine and
// casseroles a week early and broke a Saturday feast's keep windows (QA-7).
//
// The rule: a dated step keeps the offset it has in the authored Thursday plan, and
// says the weekday that offset lands on. Wednesday night before a Saturday feast is
// Friday night. So the order and the keep windows are always the authored ones.
//
// The stored recipes stay in the Thursday frame; the shift is read time. With a
// Thursday feast it is the identity, byte for byte.
//
// 🔴 D-WS9-351 — "On Thursday:" IS THE FEAST DAY'S TOKEN, NOT A WEEKDAY. The client
// (artifacts/kiwi lib/cooking/feastDay.ts) splits a dish's days by it, so it stays
// literal on the wire for release #6; CLIENT-6 displays it as "On feast day:". The
// token flips in a later release, here (FEAST_DAY_TOKEN) and nowhere else.

import { editStep } from "./birdWeight";
import { hasUnmatchedAmount, type AmountRef } from "./stepAmountRefs";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const THURSDAY = 4;

/** The served feast-day step prefix (D-WS9-351). */
export const FEAST_DAY_TOKEN = "On Thursday:";
/** "On Thursday:", and the words that will replace it ("On feast day:"), at a step's start. */
export const FEAST_DAY_PREFIX = /^\s*on (?:thursday|feast day):/i;

/** The feast's weekday (0 = Sunday) from the plan item's day name; unscheduled reads as Thursday. */
export function feastDowOf(assignedDayOfWeek: string | null): number {
  const named = assignedDayOfWeek ? DAY_NAMES.findIndex((d) => d.toLowerCase() === assignedDayOfWeek.trim().toLowerCase()) : -1;
  return named >= 0 ? named : THURSDAY;
}

/**
 * Days before the feast of an authored weekday (0 = Sunday): its offset in the
 * Thursday plan. Wednesday 1, Monday 3, Friday 6; Thursday itself is a week out.
 */
export function authoredLeadDays(dow: number): number {
  return (THURSDAY - dow + 7) % 7 || 7;
}

/** How far the feast's week turns from the authored one: 0 for a Thursday feast. */
export function feastShift(feastDow: number): number {
  return (((feastDow - THURSDAY) % 7) + 7) % 7;
}

/** The weekday an authored weekday lands on before this feast. */
export function feastWeekday(authoredDow: number, feastDow: number): string {
  return DAY_NAMES[(authoredDow + feastShift(feastDow)) % 7];
}

/** A tag naming an authored day (`ahead-wed`, `brine-tue`), said for this feast's week. */
export function feastWeekTag(tag: string, feastDow: number): string {
  const m = /^(ahead|brine)-(sun|mon|tue|wed|thu|fri|sat)$/.exec(tag);
  if (!m || feastShift(feastDow) === 0) return tag;
  return `${m[1]}-${SHORT[(SHORT.indexOf(m[2] as (typeof SHORT)[number]) + feastShift(feastDow)) % 7]}`;
}

const WEEKDAY = /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b( morning)?/g;
const TOKEN_AT_START = new RegExp(String.raw`^\s*${FEAST_DAY_TOKEN}`);
const SENTENCE_START = /(?:^|[.!?:;]\s+|\(\s*)$/;

export type FeastWeekToken = "keep" | "weekday";

/**
 * The edits that say a Thursday-plan text for this feast's week. Every weekday but
 * Thursday is shifted ("Make ahead (Wednesday night):" → "Friday night" before a
 * Saturday). Thursday is the feast: a sentence's "until Thursday", "on Thursday" says
 * "feast day" ("Thursday morning", "the morning of the feast"). The "On Thursday:"
 * prefix is the token: `keep` leaves it (the wire, D-WS9-351); `weekday` names the
 * feast's weekday, for the server's own readers that take a day from it
 * (prepFeastClose stepDayOf). No edits for a Thursday feast.
 */
export function feastWeekEdits(text: string, feastDow: number, token: FeastWeekToken): { start: number; end: number; text: string }[] {
  const shift = feastShift(feastDow);
  if (shift === 0) return [];
  const edits: { start: number; end: number; text: string }[] = [];
  const tokenEnd = TOKEN_AT_START.test(text) ? text.indexOf("Thursday") + "Thursday".length : -1;
  for (const m of text.matchAll(WEEKDAY)) {
    const start = m.index!;
    const dow = DAY_NAMES.indexOf(m[1] as (typeof DAY_NAMES)[number]);
    if (dow !== THURSDAY) {
      edits.push({ start, end: start + m[1].length, text: DAY_NAMES[(dow + shift) % 7] });
      continue;
    }
    if (start + m[1].length === tokenEnd) {
      if (token === "weekday") edits.push({ start, end: start + m[1].length, text: DAY_NAMES[feastDow] });
      continue;
    }
    const initial = SENTENCE_START.test(text.slice(0, start));
    const said = m[2] ? "the morning of the feast" : "feast day";
    edits.push({ start, end: start + m[0].length, text: initial ? said.charAt(0).toUpperCase() + said.slice(1) : said });
  }
  return edits;
}

/** A Thursday-plan text said for this feast's week (feastWeekEdits applied). */
export function feastWeekText(text: string, feastDow: number, token: FeastWeekToken): string {
  const edits = feastWeekEdits(text, feastDow, token);
  return edits.length === 0 ? text : editStep(text, null, edits).text;
}

interface ReadStep { text: string; amountRefs: AmountRef[] | null; unmatchedAmount: boolean }

/**
 * GET /meals/:id?planItemId= for a feast: its dishes' steps and row notes said for the
 * plan item's day (the token kept). Every amountRef moves with its text. Applied before
 * any read-time wording, so Prep the feast's words (built in the same week,
 * prepWeekAggregation) and the bird's thaw lines (birdWeightRead) land on it as they are.
 */
export function applyFeastWeekToRead(
  meal: { dishes: { steps: ReadStep[]; ingredients: { preparationNote: string | null }[] }[]; steps?: ReadStep[] },
  assignedDayOfWeek: string | null,
): void {
  const feastDow = feastDowOf(assignedDayOfWeek);
  if (feastShift(feastDow) === 0) return;
  const say = (st: ReadStep) => {
    const edits = feastWeekEdits(st.text, feastDow, "keep");
    if (edits.length === 0) return;
    const out = editStep(st.text, st.amountRefs, edits);
    st.text = out.text;
    st.amountRefs = out.amountRefs;
    st.unmatchedAmount = hasUnmatchedAmount(out.text, out.amountRefs);
  };
  for (const d of meal.dishes) {
    d.steps.forEach(say);
    for (const r of d.ingredients) if (r.preparationNote !== null) r.preparationNote = feastWeekText(r.preparationNote, feastDow, "keep");
  }
  meal.steps?.forEach(say);
}
