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
// __tests__/feastDay.test.ts and mealTimingBug418.test.ts keep the two together.

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
const ON_THURSDAY = /^\s*on thursday:/i;

/** A step's own prefix, or null when it carries none (it continues the run before it). */
function prefixOf(text: string): StepDay | null {
  const m = MAKE_AHEAD.exec(text);
  if (m) return { kind: "make", day: m[1].toLowerCase(), night: !!m[2] };
  if (THAW.test(text)) return { kind: "thaw" };
  if (ON_THURSDAY.test(text)) return { kind: "feast" };
  return null;
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
