// THX-3d round 2 (I) — THE PUT-IN STEP AND WHAT FOLLOWS IT (content, patch.ts, no AI).
//
// Hans's lens: the step in front of the cook says what to pick up, what to do, and when.
// After "Raise the oven to 350°F and put in the Sage and Onion Stuffing, …", the stuffing's
// own step read "On Thursday: Bake the stuffing covered for 30 minutes" — a second
// instruction to put it in. It now reads as the phase it is:
//   "On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes."
// A side the oven is heated for by another dish (the bird, the raise, another dish's
// preheat) and that no put-in step names (Small's sweet potatoes and green beans, New
// Twist's sweet potatoes and stuffing) gets its own one-line step at its start:
//   "Put the sweet potatoes in the oven." · "The sweet potatoes are in at 350°F. Roast 30–35 minutes …"
// and work written in front of the roast ("Spread the green beans on a sheet pan and
// roast …") becomes its own step before the put-in. A dish with its own preheat puts
// itself in. The temperature stays in the text (the scheduler reads it). Idempotent: a
// step that already says "is in at"/"are in at" is left alone.

import { isOvenStep, isReheatStep, HOLD_COVERED_STEP, RAISE_AND_PUT_IN, ovenTempOfText, feastRoastDish, type SchedulerPhase } from "../../src/lib/cookingScheduler";
import { onTheDaySteps } from "../../src/lib/mealTiming";
import { thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";
import type { ThursdayEdits } from "./thx2Thursday";

const DAY_PREFIX = /^(\s*On [A-Za-z]+day:\s*)/;
const PREHEAT = /\b(?:pre)?heat (?:the )?oven to \d{3}\s*°\s*F/i;
export const IN_THE_OVEN = /\b(?:is|are) in at \d{3}\s*°\s*F\b/i;
const PUT_IN_STEP = /^\s*(?:On [A-Za-z]+day:\s*)?Put the .+ in the oven\.$/i;

/** The dish as a cook says it: the step's own object ("the stuffing"), else its title's food ("the sweet potatoes"). */
export function dishNoun(title: string, text: string, titles: readonly string[]): string {
  const obj = /\b(?:bake|roast)\s+(the [a-z][a-z -]*?)(?=\s*[,(]|\s+(?:still|covered|uncovered|at|in|for|on|until)\b)/i.exec(text)?.[1]?.toLowerCase();
  const head = (s: string) => s.toLowerCase().split(/\s+/).pop() ?? "";
  const shared = (w: string) => titles.filter((t) => head(t) === w).length > 1;
  if (obj && !shared(head(obj))) return obj;
  const words = title.split(/\s+/).filter((w) => !/-/.test(w) && !/ed$/i.test(w));
  const food = (words.length ? words : title.split(/\s+/)).join(" ").toLowerCase().replace(/\bbrussels\b/, "Brussels");
  return `the ${food}`;
}

const plural = (noun: string) => /(?:[^s]s|ies|oes)$/i.test(noun.split(/\s+/).pop() ?? "") && !/(?:ss|us)$/i.test(noun);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Bake the stuffing covered for 30 minutes." → "The stuffing is in at 350°F, covered. Bake 30 minutes." (and the work written before the bake). */
export function inTheOvenText(text: string, noun: string, tempF: number): { lead: string | null; text: string } | null {
  const prefix = DAY_PREFIX.exec(text)?.[1] ?? "";
  const body = text.slice(prefix.length);
  const verb = /\b(bake|roast)\b/i.exec(body);
  if (!verb) return null;
  const leadRaw = body.slice(0, verb.index).replace(/(?:[;,]\s*|\s+)(?:and\s+)?(?:then\s+)?$/i, "").trim();
  const after = body.slice(verb.index);
  const dur = /\b(?:for\s+)?((?:about\s+)?\d+(?:\s*[–-]\s*\d+)?\s+(?:more\s+)?minutes?)(.*)$/i.exec(after);
  if (!dur) return null;
  const cover = /\buncovered\b/i.test(after.slice(0, dur.index)) ? ", uncovered" : /\bcovered\b/i.test(after.slice(0, dur.index)) ? ", covered" : "";
  const tail = dur[2].replace(/\s+$/, "");
  const sentence = `${cap(noun)} ${plural(noun) ? "are" : "is"} in at ${tempF}°F${cover}. ${cap(verb[1].toLowerCase())} ${dur[1]}${tail}`;
  // (K) A lead with no object names the dish: "Spread into a single layer" → "Spread the sweet potatoes into a single layer".
  const lead = leadRaw.replace(/^(\w+)\s+(?=(?:into|in|on|onto|over)\b)/i, `$1 ${noun} `);
  return { lead: lead ? `${cap(lead)}.` : null, text: `${prefix}${/[.!]$/.test(sentence) ? sentence : `${sentence}.`}` };
}

/** The put-in edits for a feast's Thursday (see the header). */
export function putInEdits(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): ThursdayEdits {
  const out: ThursdayEdits = { updates: [], deletes: [], creates: [], renumber: [] };
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  const bird = feastRoastDish(schedulerDishes);
  const titles = dishes.map((d) => d.title);
  const rowsOf = (dishId: string) => steps.filter((s) => s.ownerId === dishId).sort((a, b) => a.stepIndex - b.stepIndex);
  const raise = steps.find((s) => RAISE_AND_PUT_IN.test(s.stepTextTranslated));
  const raiseTemp = raise ? ovenTempOfText(raise.stepTextTranslated) : null;
  const preheatTemps = new Set(steps.filter((s) => s.phaseType === "preheat" || PREHEAT.test(s.stepTextTranslated)).map((s) => ovenTempOfText(s.stepTextTranslated)).filter((t): t is number => t !== null));
  for (const d of dishes) {
    if (bird && d.dishId === bird.dishId) continue;
    const rows = rowsOf(d.dishId);
    const day = onTheDaySteps(rows.map((r) => ({ ...r, text: r.stepTextTranslated })));
    const oven = day.find((r) => r.phaseType !== "preheat" && isOvenStep({ phaseType: r.phaseType as SchedulerPhase, text: r.text }) && !isReheatStep({ text: r.text }) && !HOLD_COVERED_STEP.test(r.text.trim()) && !PUT_IN_STEP.test(r.text));
    if (!oven || IN_THE_OVEN.test(oven.text)) continue;
    // Its own preheat before it: it puts itself in.
    if (day.some((r) => r.stepIndex < oven.stepIndex && PREHEAT.test(r.text))) continue;
    const named = !!raise && raise.stepTextTranslated.includes(d.title);
    const t = ovenTempOfText(oven.text) ?? (named ? raiseTemp : null) ?? day.map((r) => ovenTempOfText(r.text)).find((x): x is number => x !== null) ?? null;
    if (t === null) continue;
    // Heated for it by another dish: the raise that names it, the bird's oven, or another preheat at its temperature.
    if (!named && !raise && !bird && !preheatTemps.has(t)) continue;
    const noun = dishNoun(d.title, oven.text, titles);
    const w = inTheOvenText(oven.text, noun, t);
    if (!w) continue;
    if (named) {
      out.updates.push({ dishId: d.dishId, stepIndex: oven.stepIndex, text: w.lead ? `${DAY_PREFIX.exec(oven.text)?.[1] ?? ""}${w.lead} ${w.text.replace(DAY_PREFIX, "")}` : w.text });
      continue;
    }
    // Not named: [the work before it] · "Put the … in the oven." · the bake.
    const prefix = DAY_PREFIX.exec(oven.text)?.[1] ?? "";
    const inserted = w.lead ? 2 : 1;
    for (const r of rows.filter((x) => x.stepIndex >= oven.stepIndex).sort((a, b) => b.stepIndex - a.stepIndex)) {
      out.renumber.push({ dishId: d.dishId, from: r.stepIndex, to: r.stepIndex + inserted });
    }
    let at = oven.stepIndex;
    if (w.lead) out.creates.push({ dishId: d.dishId, stepIndex: at++, text: `${prefix}${w.lead}`, phaseType: "prep", estimatedMinutes: 2 });
    out.creates.push({ dishId: d.dishId, stepIndex: at, text: `${w.lead ? "" : prefix}Put ${noun} in the oven.`, phaseType: "prep", estimatedMinutes: 1 });
    out.updates.push({ dishId: d.dishId, stepIndex: oven.stepIndex, text: w.text.replace(DAY_PREFIX, "") });
  }
  return out;
}
