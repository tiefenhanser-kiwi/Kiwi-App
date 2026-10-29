// PREP-2 (D-WS9-314) — which of a Thanksgiving dish's steps belong to which day.
//
// THX-2G-F's step-phrase contract: a make-ahead run's FIRST step opens
// "Make ahead (<Day>):" (a brine "Make ahead (<Day> night):", the bird's thaw
// "Thaw (start <Day>):"), the simmer or bake inside the run is often unprefixed,
// and the day's own work opens "On Thursday:". So a step belongs to the run of the
// last prefixed step before it; steps before any prefix are the feast day's.
//
// ⚠️ THE SAME READING AS THE SERVER'S `onTheDaySteps` (api-server
// src/lib/mealTiming.ts), which the derived times and the Cooking Sequencer use.
// The client cannot import it; the shared literal vectors in
// __tests__/feastDayVectors.ts (read by feastDay.test.ts and the server's
// mealTimingBug418.test.ts) keep the two together.
//
// CLIENT-6 A (D-WS9-351) — expand, then contract. A feast need not be on a
// Thursday, so the server will one day write "On feast day:". Every installed
// client must read that as the feast day BEFORE it does: a client that knew only
// "On Thursday:" would read the turkey's roast as the end of Wednesday night's
// brine and drop it from Cook Mode. Both are read alike here, and the words shown
// follow the plan's own feast day (feastDayStep).

/** A make-ahead row, as the Hub and the dish route name it. */
export interface MakeAheadRun {
  kind: "make" | "brine" | "thaw";
  /** The row's weekday ("Wednesday"); a brine is that day's night. */
  dayName: string;
}

type StepDay =
  | { kind: "feast" }
  | { kind: "thaw" }
  | { kind: "make"; day: string; night: boolean };

const MAKE_AHEAD = /^\s*make ahead \(\s*([a-z]+)(\s+night)?\s*\)\s*:/i;
const THAW = /^\s*thaw \([^)]*\)\s*:/i;
/** "On Thursday:" or "On feast day:" — the same spacing, any case. */
const ON_FEAST_DAY = /^\s*on (?:thursday|feast day):/i;

/** A step's own prefix, or null when it carries none (it continues the run before it). */
function prefixOf(text: string): StepDay | null {
  const m = MAKE_AHEAD.exec(text);
  if (m) return { kind: "make", day: m[1].toLowerCase(), night: !!m[2] };
  if (THAW.test(text)) return { kind: "thaw" };
  if (ON_FEAST_DAY.test(text)) return { kind: "feast" };
  return null;
}

/** A leading "On Thursday:" and the space before it. */
const SAID_ON_THURSDAY = /^(\s*)on thursday:/i;
const ON_FEAST_DAY_WORDS = "On feast day:";

/**
 * CLIENT-6 A (D-WS9-351) — the words a feast step shows. When the plan's feast is
 * not on a Thursday, a leading "On Thursday:" reads "On feast day:"; a Thursday
 * feast, an unknown day (null) and every other step are returned as the same
 * object. DISPLAY ONLY: the day a step belongs to is read off the stored words,
 * which say either.
 *
 * The new words are one character longer, so every amount ref after them moves
 * with the text (a ref is a range of characters the screen draws as an amount).
 */
export function feastDayStep<S extends { text: string; amountRefs?: readonly { charStart: number; charEnd: number }[] | null }>(
  step: S,
  feastDayName: string | null | undefined,
): S {
  if (!feastDayName || feastDayName.toLowerCase() === "thursday") return step;
  const m = SAID_ON_THURSDAY.exec(step.text);
  if (!m) return step;
  const end = m[0].length;
  const by = m[1].length + ON_FEAST_DAY_WORDS.length - end;
  const text = m[1] + ON_FEAST_DAY_WORDS + step.text.slice(end);
  if (!step.amountRefs) return { ...step, text };
  const amountRefs = step.amountRefs.map((r) =>
    r.charStart >= end ? { ...r, charStart: r.charStart + by, charEnd: r.charEnd + by } : r,
  );
  return { ...step, text, amountRefs };
}

/**
 * The feast's weekday when `mealId` is the plan's feast (its make-ahead payload
 * names it), else null: the words then stay as stored.
 */
export function feastDayNameOf(
  plan: { makeAhead?: { feastMealId: string; feastDayName: string } | null } | null | undefined,
  mealId: string,
): string | null {
  const m = plan?.makeAhead;
  return m && mealId.length > 0 && m.feastMealId === mealId ? m.feastDayName : null;
}

/** Each step's day, in step order. */
function daysOf(steps: readonly { text: string }[]): StepDay[] {
  let current: StepDay = { kind: "feast" };
  return steps.map((s) => (current = prefixOf(s.text) ?? current));
}

function matches(day: StepDay, run: MakeAheadRun): boolean {
  if (run.kind === "thaw") return day.kind === "thaw";
  return day.kind === "make" && day.day === run.dayName.toLowerCase() && day.night === (run.kind === "brine");
}

/**
 * PREP-2 item 2 — the steps of one make-ahead row: "what to do on Tuesday night".
 * Null when the dish has no such run, and then the caller shows the whole dish.
 */
export function makeAheadRunSteps<T extends { text: string }>(steps: readonly T[], run: MakeAheadRun): T[] | null {
  const days = daysOf(steps);
  const out = steps.filter((_, i) => matches(days[i], run));
  return out.length > 0 ? out : null;
}

/**
 * PREP-2 item 3 — what the feast day itself cooks: every step outside a make-ahead
 * or thaw run. The client half of mealTiming `onTheDaySteps`.
 */
export function onTheDaySteps<T extends { text: string }>(steps: readonly T[]): T[] {
  const days = daysOf(steps);
  return steps.filter((_, i) => days[i].kind === "feast");
}

/** The meal tag that marks the feast (THX-2G-E's contract; hubModel FEAST_MEAL_TAG). */
const FEAST_MEAL_TAG = "thanksgiving-feast";

/**
 * PREP-2 item 3 — the feast's Cook Mode is the feast day's: Hans's 55 steps were the
 * thaw, the brine, the make-ahead runs and, after the turkey rested, "Make ahead
 * (Tuesday)" again. Those are cooked from the Hub's rows. A meal NOT tagged
 * `thanksgiving-feast` is returned as the same object, untouched.
 *
 * Both Cook Mode paths read it: the naive flatten, and the Sequencer join, whose §27
 * append would otherwise put every step the server left out back at the end.
 */
export function onTheDayMeal<M extends { tags: readonly string[]; dishes: readonly { steps: readonly { text: string }[] }[] }>(
  meal: M,
): M {
  if (!meal.tags.includes(FEAST_MEAL_TAG)) return meal;
  return { ...meal, dishes: meal.dishes.map((d) => ({ ...d, steps: onTheDaySteps(d.steps) })) };
}

/** "make:Wednesday" — the run on a route param (expo-router params are strings). */
export function encodeRun(run: MakeAheadRun): string {
  return `${run.kind}:${run.dayName}`;
}

export function decodeRun(param: string | undefined): MakeAheadRun | null {
  const m = /^(make|brine|thaw):([A-Za-z]+)$/.exec(param ?? "");
  return m ? { kind: m[1] as MakeAheadRun["kind"], dayName: m[2] } : null;
}

/** The dish screen's line under Cook Now, when Cook Mode will open one run. */
export function runCookLine(run: MakeAheadRun): string {
  switch (run.kind) {
    case "thaw":
      return "Cook Mode opens the thaw step.";
    case "brine":
      return `Cook Mode opens the ${run.dayName} night steps.`;
    case "make":
      return `Cook Mode opens the ${run.dayName} make-ahead steps.`;
  }
}
