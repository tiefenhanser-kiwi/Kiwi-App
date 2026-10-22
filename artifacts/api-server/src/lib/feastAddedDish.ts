// THX-3d (F, R6) — A DISH ADDED TO A FEAST GETS ITS DAYS.
//
// The feast's readers split a dish into its days by THX-2G-F's step phrases ("Make
// ahead (Wednesday night):", "On Thursday:") and its tags: Cook Mode (mealTiming
// onTheDaySteps, the client's feastDay), the Hub's make-ahead rows (makeAheadSchedule,
// feastPrefixes) and Prep the feast. A catalog alternate is written for any day of the
// year — the Buttermilk turkey's brine says "refrigerate — brine 12 to 24 hours", the
// sweet potato pie "or bake the day before" — so copied into a feast it named no day,
// and its overnight brine and its pie landed on Thursday's clock, competing for the
// oven. Hans, October 21: a dish a user adds "has to show up in Prep the feast and in
// Thursday's Cook Mode". So the copy writes the days IN CODE, from what the recipe
// itself says, and only when it names none:
//
//   1. A passive wait of 4 hours or more (the brine, a dry rest "overnight") — that
//      step and every step before it are the night before the feast ("Make ahead
//      (Wednesday night):"), and the next opens "On Thursday:". A bird's gets the
//      brine tag, so the Hub row reads "Into the brine".
//   2. A dessert that says it can be made the day before ("bake the day before",
//      "make ahead") — every step is the day before ("Make ahead (Wednesday):"), and a
//      code-written "On Thursday: Slice the … and serve." follows (patch.ts's step).
//   3. A whole bird that replaces one with a thaw — the new bird inherits the thaw
//      tag, and a code-written thaw step opens it, so the Hub's thaw row opens it alone.
//
// Pure: copyCatalogDishIntoMeal and patch.ts apply what it returns.

const PREFIX = /^\s*(?:make ahead \([a-z]+(?: night)?\)|thaw \(start [a-z]+\)|on [a-z]+day)\s*:/i;
/** 4 hours or more, overnight, a day: the long passive wait FINALIZE's rule keeps in a step's text. */
const LONG_WAIT = /\b(?:overnight|the day before|a day ahead|(\d{1,2})\s*(?:to|–|-)\s*(\d{1,2})\s*hours?|(\d{1,2})\s*hours?)\b/i;
const PASSIVE = /\b(?:refrigerat\w*|fridge|brine|marinat\w*|chill\w*|rest\w*|dry[- ]brine|cure)\b/i;
const DAY_BEFORE = /\b(?:bake (?:it )?the day before|make (?:it )?(?:a day )?ahead|a day ahead|the day before)\b/i;
const DESSERT = /\b(pies?|tarts?|crisps?|cobblers?|cakes?|cheesecakes?|bars|crumbles?|puddings?)\b/i;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface AddedDishStep {
  stepIndex: number;
  text: string;
}

export interface AddedDishDays {
  /** stepIndex → its new text (only the steps that change). */
  texts: Map<number, string>;
  /** The dish's tags after the copy. */
  tags: string[];
  /** Code-written steps to add (a thaw first, a serve last); later steps move down by `shift`. */
  creates: { stepIndex: number; text: string; phaseType: "prep" | "assemble"; estimatedMinutes: number }[];
  /** How far every existing step moves down (1 when a thaw step opens the dish). */
  shift: number;
}

/** True when a passive wait of 4 hours or more is stated in this text. */
export function statesLongWait(text: string): boolean {
  const m = LONG_WAIT.exec(text);
  if (!m || !PASSIVE.test(text)) return false;
  if (m[1] !== undefined) return Number(m[2]) >= 4;
  if (m[3] !== undefined) return Number(m[3]) >= 4;
  return true;
}

/** The code-written thaw step (THX-2G-F's phrase): the bird into the fridge on its day. */
export function thawStepText(birdWord: string, startDay: string, readyBy: string): string {
  return `Thaw (start ${startDay}): If the ${birdWord} is frozen, move it to the fridge on ${startDay} so it is fully thawed by ${readyBy}.`;
}

export function feastDaysForAddedDish(input: {
  title: string;
  tags: readonly string[];
  steps: readonly AddedDishStep[];
  /** A whole bird (prepQuantity's detectors, read by the caller). */
  isWholeBird: boolean;
  /** The tags of the dish this one replaces, if any (its thaw is inherited). */
  replacedTags?: readonly string[];
  /** The feast's weekday (Thursday). */
  feastDay?: string;
}): AddedDishDays {
  const out: AddedDishDays = { texts: new Map(), tags: [...input.tags], creates: [], shift: 0 };
  const steps = [...input.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  if (steps.length === 0 || steps.some((s) => PREFIX.test(s.text))) return out;
  const fi = Math.max(0, WEEKDAYS.indexOf(input.feastDay ?? "Thursday"));
  const before = WEEKDAYS[(fi + 6) % 7];
  const last = steps[steps.length - 1].stepIndex;

  const dessert = input.tags.includes("course-dessert") || DESSERT.test(input.title);
  const waitAt = steps.findIndex((s) => statesLongWait(s.text));
  if (dessert && steps.some((s) => DAY_BEFORE.test(s.text))) {
    // 2 — the whole dessert the day before, then sliced on the day.
    for (const s of steps) out.texts.set(s.stepIndex, `Make ahead (${before}): ${s.text}`);
    out.tags.push(`ahead-${SHORT[(fi + 6) % 7]}`);
    out.creates.push({ stepIndex: last + 1, text: `On ${WEEKDAYS[fi]}: Slice the ${input.title} and serve.`, phaseType: "assemble", estimatedMinutes: 2 });
  } else if (waitAt >= 0 && waitAt < steps.length - 1) {
    // 1 — through the long wait, the night before; the rest on the day.
    for (const s of steps.slice(0, waitAt + 1)) out.texts.set(s.stepIndex, `Make ahead (${before} night): ${s.text}`);
    const next = steps[waitAt + 1];
    out.texts.set(next.stepIndex, `On ${WEEKDAYS[fi]}: ${next.text}`);
    if (input.isWholeBird) out.tags.push(`brine-${SHORT[(fi + 6) % 7]}`);
  }

  // 3 — the replaced bird's thaw.
  const thaw = (input.replacedTags ?? []).map((t) => /^thaw-(\d+)d$/.exec(t)).find((m) => m);
  if (input.isWholeBird && thaw && !out.tags.some((t) => /^thaw-\d+d$/.test(t))) {
    const n = Number(thaw[1]);
    const word = /\bbreast\b/i.test(input.title) ? "turkey breast" : /\bchicken\b/i.test(input.title) ? "chicken" : "turkey";
    out.tags.push(`thaw-${n}d`);
    out.shift = 1;
    for (const c of out.creates) c.stepIndex += 1;
    out.creates.unshift({ stepIndex: 0, text: thawStepText(word, WEEKDAYS[(((fi - n) % 7) + 7) % 7], before), phaseType: "prep", estimatedMinutes: 2 });
  }
  return out;
}
