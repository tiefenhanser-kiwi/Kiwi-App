// THX-3d (D, R4) — THURSDAY, FOR EVERY FEAST: THE CONTENT HALF. Pure; patch.ts runs it,
// no AI. The scheduler half is cookingScheduler's (the holder by kind, the oven freed at
// the raise step, the drippings after the bird, the serve step last, dessert after it).
//
// Hans, October 21: "the dishes that need 350 should go in so they finish about 5-10
// minutes before the bird finishes resting … It's ok to have the turkey finish at a
// higher temp … we shouldn't keep the 'preheat to 350' steps for each dish … there
// would be a step to up the oven to 350 and put in the three dishes … pies get cut
// after the feast is on the table … cranberry sauce is a cold dish that goes out when
// everything else is served … I'm wondering if we need a step that says to serve it at
// all." The rules, as chat-Claude wrote them (THX-3d D):
//
//   pre-pass (before the oven passes)
//     • the room-temperature sit is a HOLD step with its real minutes;
//     • the bird rests 20–30 minutes (a breast 20);
//     • a bird HOTTER than its sides: a side whose own text gives the bird's
//       temperature as an option joins the bird at it (its own preheat goes);
//     • where the oven is already hot (the raise heats it), no side's preheat text
//       survives: a pure preheat goes (its "On Thursday:" moves to the next step), a
//       "Preheat the oven to 350°F; bake …" loses the clause;
//     • every serve-only step goes ("Serve the stuffing directly from the dish"), and
//       every serve clause ("…; serve from the dish", "and serve immediately") — the
//       dessert's own excepted, it is served after the meal;
//     • THX-3c's "As the turkey comes out, raise the oven to 350°F for the sides." goes.
//   post-pass (after them)
//     • ONE code-written raise step while the bird roasts — "Raise the oven to 350°F
//       and put in the …" — timed so the longest side finishes 5 minutes before the
//       rest ends; the roast is split around it and finishes at the higher temperature,
//       its time adjusted (the baker's 10% per 25°F);
//     • ONE serve step after the carve, naming every dish on the table.

import {
  BIRD_HOTTER_F,
  DESSERT_DISH,
  FEAST_SERVE_STEP,
  RAISE_AND_PUT_IN,
  feastRoastDish,
  feastServeText,
  isOvenStep,
  isReheatStep,
  lastOvenTempOfText,
  mergeFeastPreheats,
  ovenTempOfText,
  planOven,
  type SchedulerPhase,
} from "../../src/lib/cookingScheduler";
import { onTheDaySteps } from "../../src/lib/mealTiming";
import { PUT_IN_WITH_MINUTES, RAISE_MINUTES, RETIME_PER_25F, thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";

export interface ThursdayEdits {
  /** A stored or created step's new text, minutes or phase (by dish and current index). */
  updates: { dishId: string; stepIndex: number; text?: string; minutes?: number; phaseType?: SchedulerPhase }[];
  deletes: { dishId: string; stepIndex: number }[];
  /** Code-written steps; `renumber` moves the dish's later steps down first. */
  creates: { dishId: string; stepIndex: number; text: string; phaseType: SchedulerPhase; estimatedMinutes: number }[];
  renumber: { dishId: string; from: number; to: number }[];
}

const empty = (): ThursdayEdits => ({ updates: [], deletes: [], creates: [], renumber: [] });

const DAY_PREFIX = /^(\s*On [A-Za-z]+day:\s*)/;
const PURE_PREHEAT = /^\s*(?:On [A-Za-z]+day:\s*)?(?:Pre)?heat (?:the )?oven to (\d{3})\s*°\s*F(?:\s*\([^)]*\))?\.?\s*$/i;
const PREHEAT_CLAUSE = /^(\s*(?:On [A-Za-z]+day:\s*)?)(?:Pre)?heat (?:the )?oven to (\d{3})\s*°\s*F\s*[;,.]\s*/i;
const BIRD_PAREN = /\s*\((?:after|while|once|before)[^)]*\b(?:turkey|bird)\b[^)]*\)/gi;
const OLD_RAISE = /^\s*As the \w+ comes out, raise the oven to \d{3}\s*°\s*F for the sides\.\s*$/i;
const SERVE_ONLY = /^(?:serve\b|spoon .{0,80}\binto a serving (?:bowl|dish)\b|transfer .{0,80}\bto a serving (?:bowl|dish|platter)\b.{0,10}\band serve\b|scoop and serve\b)/i;
const COOK_VERB = /\b(bake|roast|boil|simmer|heat|reheat|mash|season|whisk|garnish|scatter|squeeze|drizzle|toss|stir|fold|sprinkle|slice|carve|dot|pour|cook|melt|broil)\b/i;
const SERVE_CLAUSE = /(?:\s*[;,]\s*(?:then\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+)(?:scoop and\s+)?serve\b[^.;]*/gi;
const SIT_AT_ROOM = /\b(?:let (?:it|the (?:turkey|bird|breast)) )?sit at room temperature for\s+(an?|one|\d+)\s+(hours?|minutes?)\b/i;
const BEFORE_ROASTING = /\b(an?|one|\d+)\s+(hours?|minutes?)\s+before roasting\b/i;

const minutesOf = (n: string, unit: string) => (/^(?:an?|one)$/i.test(n) ? 1 : Number(n)) * (/^hour/i.test(unit) ? 60 : 1);
const cap = (s: string) => s.replace(/^\s*([a-z])/, (_m, c: string) => c.toUpperCase());
const sentence = (s: string) => (/[.!?]\s*$/.test(s) ? s.trim() : `${s.trim()}.`);

interface Row { dishId: string; stepIndex: number; text: string; phaseType: string; minutes: number }

function rowsOf(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const d of dishes) {
    out.set(d.dishId, steps.filter((s) => s.ownerId === d.dishId).sort((a, b) => a.stepIndex - b.stepIndex)
      .map((s) => ({ dishId: d.dishId, stepIndex: s.stepIndex, text: s.stepTextTranslated, phaseType: s.phaseType, minutes: s.estimatedMinutes })));
  }
  return out;
}

/** The dish's Thursday steps (THX-2G-F's phrases), as rows. */
function thursdayOf(rows: readonly Row[]): Row[] {
  return onTheDaySteps(rows.map((r) => ({ ...r }))) as Row[];
}

/** The pre-pass edits (see the header). */
export function thursdayPrePass(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): ThursdayEdits {
  const out = empty();
  const byDish = rowsOf(dishes, steps);
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  const roast = feastRoastDish(schedulerDishes);
  const birdDish = roast ? dishes.find((d) => d.dishId === roast.dishId)! : null;
  const birdRows = birdDish ? byDish.get(birdDish.dishId)! : [];
  const birdTemp = birdDish
    ? thursdayOf(birdRows).filter((r) => isOvenStep({ phaseType: r.phaseType as SchedulerPhase, text: r.text })).map((r) => lastOvenTempOfText(r.text)).filter((t): t is number => t !== null).pop() ?? null
    : null;
  const sideTemps = dishes.filter((d) => d.dishId !== birdDish?.dishId).flatMap((d) =>
    thursdayOf(byDish.get(d.dishId)!).filter((r) => r.phaseType !== "preheat" && isOvenStep({ phaseType: r.phaseType as SchedulerPhase, text: r.text }) && !isReheatStep({ text: r.text })).map((r) => ovenTempOfText(r.text)).filter((t): t is number => t !== null));
  const birdHotter = birdTemp !== null && sideTemps.some((t) => t < birdTemp - BIRD_HOTTER_F);

  // The bird: its sit, its rest, THX-3c's old raise step.
  if (birdDish) {
    const breast = /\bbreast\b/i.test(birdDish.title);
    const day = thursdayOf(birdRows);
    let split = false;
    for (const r of day) {
      if (OLD_RAISE.test(r.text)) { out.deletes.push({ dishId: r.dishId, stepIndex: r.stepIndex }); continue; }
      if (r.phaseType === "rest") {
        const text = r.text
          .replace(/\b(\d{2})\s*(?:–|-|to)\s*(\d{2})\s*minutes\b/i, (all, a: string) => (Number(a) >= 30 ? "20–30 minutes" : all))
          .replace(/\brest (\d{2}) minutes\b/i, (all, a: string) => (Number(a) > 25 ? "rest 20–30 minutes" : all));
        const minutes = breast ? Math.min(r.minutes, 20) : Math.min(r.minutes, 25);
        if (text !== r.text || minutes !== r.minutes) out.updates.push({ dishId: r.dishId, stepIndex: r.stepIndex, text, minutes });
        continue;
      }
      const sit = SIT_AT_ROOM.exec(r.text) ?? BEFORE_ROASTING.exec(r.text);
      if (!sit || split || r.phaseType === "hold" || r.phaseType === "preheat") continue;
      const minutes = minutesOf(sit[1], sit[2]);
      const clauses = r.text.split(/\s*;\s*/);
      const at = clauses.findIndex((c) => SIT_AT_ROOM.test(c) || BEFORE_ROASTING.test(c));
      if (clauses.length === 1) {
        out.updates.push({ dishId: r.dishId, stepIndex: r.stepIndex, phaseType: "hold", minutes });
        continue;
      }
      const prefix = DAY_PREFIX.exec(r.text)?.[1] ?? "";
      const sitText = clauses[at].replace(DAY_PREFIX, "").replace(/^let it\b/i, "let the turkey");
      const work = clauses.filter((_, i) => i !== at).map((c) => c.replace(DAY_PREFIX, "")).join("; ");
      // The clause order is the recipe's: the sit first (New Twist), or the work first (Classic).
      const [first, second] = at === 0
        ? [{ text: `${prefix}${sentence(cap(sitText))}`, phaseType: "hold" as const, minutes }, { text: sentence(cap(work)), phaseType: "prep" as const, minutes: Math.max(2, r.minutes) }]
        : [{ text: `${prefix}${sentence(cap(work))}`, phaseType: r.phaseType as SchedulerPhase, minutes: r.minutes }, { text: sentence(cap(sitText)), phaseType: "hold" as const, minutes }];
      // Edits name CURRENT indexes; the patch applies updates and deletes, then the
      // renumbers, then the creates at their final index. One sit per bird.
      out.updates.push({ dishId: r.dishId, stepIndex: r.stepIndex, text: first.text, phaseType: first.phaseType, minutes: first.minutes });
      for (const later of birdRows.filter((x) => x.stepIndex > r.stepIndex).sort((a, b) => b.stepIndex - a.stepIndex)) {
        out.renumber.push({ dishId: r.dishId, from: later.stepIndex, to: later.stepIndex + 1 });
      }
      out.creates.push({ dishId: r.dishId, stepIndex: r.stepIndex + 1, text: second.text, phaseType: second.phaseType, estimatedMinutes: second.minutes });
      split = true;
    }
  }

  // The sides.
  for (const d of dishes) {
    if (d.dishId === birdDish?.dishId) continue;
    const rows = byDish.get(d.dishId)!;
    const day = thursdayOf(rows);
    const dessert = DESSERT_DISH.test(d.title);
    let carry: string | null = null;
    for (const r of day) {
      let text: string = carry && !DAY_PREFIX.test(r.text) ? `${carry}${r.text}` : r.text;
      carry = null;
      let minutes = r.minutes;
      // A bird hotter than this side: the side's own hotter option joins the bird.
      if (birdHotter && birdTemp !== null) {
        const opt = new RegExp(`\\bat (\\d{3})\\s*°\\s*F for (\\d+)(?:\\s*(?:–|-|to)\\s*(\\d+))? minutes \\(or ${birdTemp}\\s*°\\s*F for (\\d+)(?:\\s*(?:–|-|to)\\s*(\\d+))? minutes\\)`, "i").exec(text);
        if (opt) {
          text = text.replace(opt[0], `at ${birdTemp}°F for ${opt[4]}${opt[5] ? `–${opt[5]}` : ""} minutes`);
          minutes = Number(opt[5] ?? opt[4]);
        }
        const pure = PURE_PREHEAT.exec(text);
        if (pure && Number(pure[1]) === birdTemp && day.some((x) => new RegExp(`\\b${birdTemp}\\s*°\\s*F for`).test(x.text) || (opt && x === r))) {
          out.deletes.push({ dishId: d.dishId, stepIndex: r.stepIndex });
          carry = DAY_PREFIX.exec(text)?.[1] ?? null;
          continue;
        }
        if (/\(or \d{3}\s*°\s*F if baking after the turkey[^)]*\)/i.test(text)) text = text.replace(/\s*\(or \d{3}\s*°\s*F if baking after the turkey[^)]*\)/i, "");
      }
      // (Where the raise heats the oven, the side's own preheat goes — the post-pass,
      // once the raise is written: the sides' temperature is read off those preheats.)
      text = text.replace(BIRD_PAREN, "");
      // Serve: the one serve step does it; a dessert is served after the meal, as written.
      if (!dessert && !FEAST_SERVE_STEP.test(text)) {
        const body = text.replace(DAY_PREFIX, "");
        if (SERVE_ONLY.test(body) && !COOK_VERB.test(body.replace(/\bserv\w*/gi, ""))) {
          out.deletes.push({ dishId: d.dishId, stepIndex: r.stepIndex });
          carry = DAY_PREFIX.exec(text)?.[1] ?? null;
          continue;
        }
        const stripped = text.replace(SERVE_CLAUSE, "").replace(/\s*\.\s*Serve\b[^.]*\./gi, ".").replace(/\s+([.;])/g, "$1").replace(/[,;]+\s*(?=\.|$)/g, "");
        if (stripped.trim().length > 0) text = sentence(stripped);
      }
      if (text !== r.text || minutes !== r.minutes) out.updates.push({ dishId: d.dishId, stepIndex: r.stepIndex, text, ...(minutes !== r.minutes ? { minutes } : {}) });
    }
  }
  return out;
}

const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
function aboutDuration(min: number): string {
  if (min < 60) return `about ${round5(min)} minutes`;
  const q = Math.round(min / 15) / 4;
  const whole = Math.floor(q);
  const frac = q - whole;
  const glyph = frac === 0.25 ? "¼" : frac === 0.5 ? "½" : frac === 0.75 ? "¾" : "";
  const n = `${whole}${glyph}`;
  return `about ${n} ${q === 1 ? "hour" : "hours"}`;
}

/** The roast's text with its time cut to `minutes` (the doneness clause goes to the finish step). */
export function shortenRoastText(text: string, minutes: number): string {
  // The last OVEN temperature (not the thigh's 165°F) ends the head.
  let cut = -1;
  for (const m of text.matchAll(/(\d{3})\s*°\s*F/g)) {
    const t = Number(m[1]);
    if (t >= 250 && t <= 550) cut = (m.index ?? 0) + m[0].length;
  }
  if (cut < 0) return text;
  const head = text.slice(0, cut);
  // Minutes the head already states (Small's "425°F for 20 minutes to brown the skin").
  const stated = [...head.matchAll(/\bfor (\d+)\s*minutes\b/gi)].reduce((s, m) => s + Number(m[1]), 0);
  const tail = text.slice(cut)
    .replace(/,?\s*until [^.;]*?\b1[56]\d\s*°\s*F[^.;]*/i, "")
    .replace(/,?\s*(?:for\s+)?(?:about\s+)?\d+(?:\s*[½¼¾])?(?:\s*(?:–|-|to)\s*\d+(?:\s*[½¼¾])?)?\s*(?:hours?|minutes?)(?:\s+more)?(?:\s*\([^)]*\))?(?:\s+for an? [^.;]*?\bbird)?/gi, "")
    .replace(/\s+([.;])/g, "$1")
    .replace(/^\s*\./, "");
  // "…reduce the oven to 325°F and continue roasting for about 30 minutes."
  return sentence(`${head}${tail.replace(/[.\s]+$/, "")} for ${aboutDuration(Math.max(5, minutes - stated))}`);
}

/** The post-pass edits: the raise step and the roast split, and the one serve step. */
export function thursdayPostPass(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): ThursdayEdits {
  const out = empty();
  const byDish = rowsOf(dishes, steps);
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  const merged = mergeFeastPreheats(schedulerDishes).dishes;
  const roast = feastRoastDish(merged);
  const plan = planOven(merged);
  const birdDish = roast ? dishes.find((d) => d.dishId === roast.dishId)! : null;
  let birdShift = 0;

  if (plan && birdDish) {
    const hd = merged.find((d) => d.dishId === birdDish.dishId)!;
    const rows = byDish.get(birdDish.dishId)!;
    const oven = (r: Row) => isOvenStep({ phaseType: r.phaseType as SchedulerPhase, text: r.text }) && !isReheatStep({ text: r.text });
    // The sides: every other dish that uses the oven on the day. Their temperature is read
    // off all their oven steps, their own preheats included (before those go, below).
    const sides = dishes
      .filter((d) => d.dishId !== birdDish.dishId)
      .map((d) => ({ d, day: thursdayOf(byDish.get(d.dishId)!) }))
      .filter((x) => x.day.some(oven));
    const temps = sides.flatMap((x) => x.day.filter(oven).map((r) => ovenTempOfText(r.text)).filter((t): t is number => t !== null));
    const target = temps.length > 0 ? Math.max(...temps) : null;
    // A side's run: from its first oven step that is not a preheat to the end of its last.
    const run = (day: readonly Row[]) => {
      const ov = day.map((r, i) => (r.phaseType !== "preheat" && oven(r) ? i : -1)).filter((i) => i >= 0);
      return ov.length === 0 ? 0 : day.slice(Math.min(...ov), Math.max(...ov) + 1).reduce((s, x) => s + x.minutes, 0);
    };
    const runs = sides.map((x) => ({ title: x.d.title, run: run(x.day) }));
    const S = Math.max(0, ...runs.map((r) => r.run));
    // Into the oven at the raise: the sides that would finish within 10 minutes of the
    // longest ("the three dishes, or two of the three, or whatever the timing dictates");
    // a shorter one goes in later, on its own step (the oven is hot by then).
    const names = runs.filter((r) => r.run >= S - 10).map((r) => r.title);
    const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const roastStep = hd.steps[plan.holderLastOven];
    const birdTemp = lastOvenTempOfText(roastStep.text);
    const part = /\bbreast\b/i.test(birdDish.title) ? "breast" : "thigh";
    const noun = /\bbreast\b/i.test(birdDish.title) ? "turkey breast" : (/\b(turkey|chicken|duck|goose|hen)\b/i.exec(birdDish.title)?.[1]?.toLowerCase() ?? "roast");
    // THX-3d round 3 (T) — at the bird's own temperature there is nothing to raise: the
    // sides go in with it ("Put the … in the oven with the turkey.").
    // The bird's own temperature is its FIRST roast's: once a raise is written, the last
    // oven step is "Keep roasting … at 350°F", the sides' temperature.
    const firstRoast = hd.steps.find((s) => s.phaseType === "cook" && isOvenStep(s));
    const ownTemp = firstRoast ? lastOvenTempOfText(firstRoast.text) : birdTemp;
    const same = target !== null && ownTemp !== null && target === ownTemp;
    const raiseText = target !== null && names.length > 0 ? (same ? `Put the ${list} in the oven with the ${noun}.` : `Raise the oven to ${target}°F and put in the ${list}.`) : null;
    const raiseMinutes = same ? PUT_IN_WITH_MINUTES : RAISE_MINUTES;
    const existing = rows.find((r) => RAISE_AND_PUT_IN.test(r.text));
    if (existing) {
      if (raiseText && existing.text !== raiseText) out.updates.push({ dishId: existing.dishId, stepIndex: existing.stepIndex, text: raiseText });
    } else if (raiseText && target !== null) {
      const restIdx = hd.steps.findIndex((s, i) => i > plan.holderLastOven && s.phaseType === "rest");
      const rest = restIdx >= 0 ? hd.steps[restIdx].estimatedMinutes : 25;
      const high = S - rest + 5; // the bird's minutes at the sides' temperature, after the raise
      const factor = 1 + (RETIME_PER_25F * ((target - (birdTemp ?? target)) / 25));
      const low = roastStep.estimatedMinutes - raiseMinutes - Math.round(high * factor);
      if (roastStep.phaseType === "cook" && birdTemp !== null && target >= birdTemp && high > 5 && low > 15) {
        out.updates.push({ dishId: birdDish.dishId, stepIndex: roastStep.stepIndex, text: shortenRoastText(roastStep.text ?? "", low), minutes: low });
        for (const later of rows.filter((x) => x.stepIndex > roastStep.stepIndex).sort((a, b) => b.stepIndex - a.stepIndex)) {
          out.renumber.push({ dishId: birdDish.dishId, from: later.stepIndex, to: later.stepIndex + 2 });
        }
        out.creates.push(
          { dishId: birdDish.dishId, stepIndex: roastStep.stepIndex + 1, text: raiseText, phaseType: same ? "prep" : "preheat", estimatedMinutes: raiseMinutes },
          { dishId: birdDish.dishId, stepIndex: roastStep.stepIndex + 2, text: `Keep roasting the ${noun} at ${target}°F for about ${round5(high)} more minutes, until an instant-read thermometer in the thickest part of the ${part} reads 165°F.`, phaseType: "cook", estimatedMinutes: high },
        );
        birdShift = 2;
      } else if (birdTemp !== null && target !== birdTemp) {
        // The sides fit in the rest: the oven is raised as the bird comes out.
        for (const later of rows.filter((x) => x.stepIndex > roastStep.stepIndex).sort((a, b) => b.stepIndex - a.stepIndex)) {
          out.renumber.push({ dishId: birdDish.dishId, from: later.stepIndex, to: later.stepIndex + 1 });
        }
        out.creates.push({ dishId: birdDish.dishId, stepIndex: roastStep.stepIndex + 1, text: raiseText, phaseType: "preheat", estimatedMinutes: RAISE_MINUTES });
        birdShift = 1;
      }
    }
    // THX-3d round 3 (T) — the bird's rest no longer roasts: "Keep roasting … until
    // 165°F" says it ("Roast until an instant-read thermometer reads 165°F …; transfer to a
    // cutting board and rest 20–30 minutes" → "Transfer the turkey to a cutting board …").
    if (existing || birdShift > 0) {
      for (const r of thursdayOf(rows).filter((x) => x.phaseType === "rest")) {
        const m = /^(\s*(?:On [A-Za-z]+day:\s*)?)Roast until [^;]*\b1[56]\d\s*°\s*F[^;]*;\s*(.+)$/i.exec(r.text);
        if (!m) continue;
        const next = `${m[1]}${cap(m[2].replace(/^transfer to\b/i, `transfer the ${noun} to`))}`;
        out.updates.push({ dishId: r.dishId, stepIndex: r.stepIndex, text: next });
      }
    }
    // The raise heats the oven: no side's own preheat to its temperature survives. A pure
    // preheat goes (its "On Thursday:" moves to the dish's next step); a "Preheat the oven
    // to 350°F; bake …" loses the clause.
    if (target !== null && (existing || birdShift > 0)) {
      for (const { d, day } of sides) {
        let carry: string | null = null;
        for (const r of day) {
          let text: string = carry && !DAY_PREFIX.test(r.text) ? `${carry}${r.text}` : r.text;
          carry = null;
          const pure = PURE_PREHEAT.exec(text);
          if (pure && Number(pure[1]) === target) {
            out.deletes.push({ dishId: d.dishId, stepIndex: r.stepIndex });
            carry = DAY_PREFIX.exec(text)?.[1] ?? null;
            continue;
          }
          const clause = PREHEAT_CLAUSE.exec(text);
          if (clause && Number(clause[2]) === target) text = `${clause[1]}${cap(text.slice(clause[0].length))}`;
          if (text !== r.text) out.updates.push({ dishId: d.dishId, stepIndex: r.stepIndex, text });
        }
      }
    }
  }

  // The one serve step: after the carve (the bird's last step), or after the main dish.
  const owner = birdDish ?? dishes.find((d) => /\bmain\b/i.test(d.roleLabel ?? "")) ?? [...dishes].sort((a, b) => a.positionIndex - b.positionIndex)[0];
  if (owner) {
    const others = [...dishes]
      .sort((a, b) => a.positionIndex - b.positionIndex)
      .filter((d) => d.dishId !== owner.dishId && !DESSERT_DISH.test(d.title))
      .map((d) => d.title);
    const text = feastServeText(owner.title, others);
    const rows = byDish.get(owner.dishId)!;
    const existing = rows.find((r) => FEAST_SERVE_STEP.test(r.text));
    if (existing) {
      if (existing.text !== text) out.updates.push({ dishId: owner.dishId, stepIndex: existing.stepIndex, text });
    } else {
      const top = Math.max(...rows.map((r) => r.stepIndex)) + (owner.dishId === birdDish?.dishId ? birdShift : 0);
      out.creates.push({ dishId: owner.dishId, stepIndex: top + 1, text, phaseType: "assemble", estimatedMinutes: 2 });
    }
  }
  return out;
}
