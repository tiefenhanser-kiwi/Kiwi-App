// PREP-1 (D-WS9-314) — the Hub's "Thanksgiving make-ahead" card, as a pure model.
//
// The server sends the schedule as data (GET /plans/:id `makeAhead`, built from
// the feast dishes' tags and the plan's dates); the words are written here, so
// the copy ships over the air. Rows are grouped by day in the server's order —
// a brine is its day's NIGHT, so it gets a group of its own after the day's
// make-ahead work ("Wednesday night").

import type { MakeAhead, MakeAheadRow } from "@/lib/api/plans";
import { encodeRun, type MakeAheadRun } from "@/lib/cooking/feastDay";

export const MAKE_AHEAD_CARD_TITLE = "Thanksgiving make-ahead";
export const PREP_THE_FEAST_LABEL = "Prep the feast";
/** Prep the Week's one line when the plan has a feast (the week no longer covers it). */
export const FEAST_HAS_OWN_PREP_LINE = "The feast has its own prep. See Thanksgiving make-ahead.";

export interface MakeAheadRowVM {
  key: string;
  /** PREP-2 — the row opens THIS dish, read from the feast meal in plan context. */
  dishId: string;
  mealId: string;
  planItemId: string | null;
  /** PREP-2 — which of the dish's steps the row is: Cook Mode opens that run only. */
  run: MakeAheadRun;
  title: string;
  note: string;
}

/**
 * PREP-2 — where a day sits against today. `current` is today's day, or the next
 * upcoming one when today has none (Hans: "today's or the next upcoming day is
 * highlighted"); `past` days collapse into the one "Done days" line. An undated
 * plan cannot tell, so every day reads `upcoming` and nothing collapses.
 */
export type MakeAheadDayWhen = "past" | "current" | "upcoming";

export interface MakeAheadDayVM {
  key: string;
  /** "Saturday · Nov 21", "Wednesday night · Nov 25", or "Saturday" when undated. */
  label: string;
  rows: MakeAheadRowVM[];
  when: MakeAheadDayWhen;
  /** The highlighted day's eyebrow: "Today", or "Next" when it is a later day. */
  highlight: "Today" | "Next" | null;
}

export interface MakeAheadCardVM {
  title: string;
  /** "Thanksgiving is Thursday, Nov 26." */
  feastLine: string;
  /** Today's and the coming days, in order. */
  days: MakeAheadDayVM[];
  /** PREP-2 — the days before today, behind one "Done days" line. */
  doneDays: MakeAheadDayVM[];
  /** "Done days (2)", or null when no day is past. */
  doneDaysLine: string | null;
  /** Shown when no dish carries a make-ahead tag: the card is the button. */
  emptyLine: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-21" → "Nov 21". Read as a calendar date: no Date, no time zone. */
export function shortDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

/** PREP-2 — today as a calendar date in the phone's own zone, "2026-11-24". */
export function localIsoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** `feastDayName` — the day an `assemble` dish is baked ("Thursday"). */
export function makeAheadNote(row: MakeAheadRow, feastDayName = "Thursday"): string {
  switch (row.kind) {
    case "thaw":
      return row.thawDays !== undefined
        ? `Into the fridge to thaw — ${days(row.thawDays)} before`
        : "Into the fridge to thaw";
    case "make":
      // PREP-2 — Hans: "making it ahead of time does not mean putting it in the oven.
      // oven happens the day of the meal." The tag says which dishes those are.
      if (row.assemble) return `Assemble ahead · bake ${feastDayName}`;
      return row.keepsDays !== undefined ? `Make ahead · keeps ${days(row.keepsDays)}` : "Make ahead";
    case "brine":
      if (!row.brineHours) return "Into the brine · hands-off";
      // "48 hours" is one figure on the wire as min = max.
      return row.brineHours.min === row.brineHours.max
        ? `Into the brine · hands-off ${row.brineHours.min} h`
        : `Into the brine · hands-off ${row.brineHours.min}–${row.brineHours.max} h`;
  }
}

export interface MakeAheadDishRoute {
  pathname: "/dish/[id]";
  params: { id: string; mealId: string; run: string; planId?: string; planItemId?: string };
}

/**
 * PREP-2 item 2 — where a make-ahead row goes: THE DISH. Hans: "when I click on the
 * cards it goes to the MEAL, not the individual dish. it should go to the dish."
 * (This replaces PREP-1 F's meal-detail route.)
 *
 * The dish screen reads it out of the feast MEAL in plan context (mealId, planId,
 * planItemId), so its amounts scale to the plan's servings exactly as meal detail's
 * do — the bare GET /dishes/:id reads the dish's own default. `run` is the row's
 * day: Cook Mode from there opens that run's steps only. Without a plan item (an
 * older server, no plan item found) it is the feast meal at its own servings.
 */
export function makeAheadDishRoute(
  planId: string,
  row: Pick<MakeAheadRowVM, "dishId" | "mealId" | "planItemId" | "run">,
): MakeAheadDishRoute {
  const base = { id: row.dishId, mealId: row.mealId, run: encodeRun(row.run) };
  return {
    pathname: "/dish/[id]",
    params: row.planItemId && planId ? { ...base, planId, planItemId: row.planItemId } : base,
  };
}

/** `base`, or `base#2`, `base#3` … — the first not yet in `seen` (which it joins). */
function uniqueKey(seen: Set<string>, base: string): string {
  let k = base;
  for (let n = 2; seen.has(k); n++) k = `${base}#${n}`;
  seen.add(k);
  return k;
}

/**
 * `planItemId` — the feast's plan item when the server did not send it.
 * `todayIso` — PREP-2: today's calendar date ("2026-11-24", `localIsoDate`). Days
 * before it go behind "Done days"; the first day on or after it is highlighted.
 * Omitted (or an undated plan): no day is past and none is highlighted.
 */
export function buildMakeAheadCard(
  m: MakeAhead,
  planItemId: string | null = null,
  todayIso: string | null = null,
): MakeAheadCardVM {
  const itemId = m.feastPlanItemId ?? planItemId;
  const out: (MakeAheadDayVM & { date: string | null })[] = [];
  // WEB-4b (BUG-455) — a row key names its day too: Make-Ahead's stuffing has two
  // make rows (Tuesday's bread, Wednesday's assembly), and kind + dish alone
  // collided. A repeat on the same day (never seen) still gets its own key.
  const rowKeys = new Set<string>();
  for (const row of m.rows) {
    const night = row.kind === "brine";
    const key = `${row.date ?? row.dayName}${night ? "-night" : ""}`;
    let day = out.find((d) => d.key === key);
    if (!day) {
      const date = row.date ? shortDate(row.date) : null;
      day = {
        key,
        label: `${row.dayName}${night ? " night" : ""}${date ? ` · ${date}` : ""}`,
        rows: [],
        when: "upcoming",
        highlight: null,
        date: row.date,
      };
      out.push(day);
    }
    day.rows.push({
      key: uniqueKey(rowKeys, `${row.kind}-${row.dishId}-${key}`),
      dishId: row.dishId,
      mealId: row.mealId,
      planItemId: itemId,
      run: { kind: row.kind, dayName: row.dayName },
      title: row.dishName,
      note: makeAheadNote(row, m.feastDayName),
    });
  }
  // The highlighted date: today's, or the next one with work on it. A night shares
  // its day's date, so Wednesday and Wednesday night light up together.
  const valid = todayIso && /^\d{4}-\d{2}-\d{2}$/.test(todayIso) ? todayIso : null;
  const next = valid
    ? out.map((d) => d.date).filter((d): d is string => d !== null && d >= valid).sort()[0] ?? null
    : null;
  for (const d of out) {
    if (!valid || d.date === null) continue;
    if (d.date < valid) d.when = "past";
    else if (d.date === next) {
      d.when = "current";
      d.highlight = d.date === valid ? "Today" : "Next";
    }
  }
  const strip = ({ date: _date, ...d }: MakeAheadDayVM & { date: string | null }): MakeAheadDayVM => d;
  const doneDays = out.filter((d) => d.when === "past").map(strip);
  const feastDate = m.feastDate ? shortDate(m.feastDate) : null;
  return {
    title: MAKE_AHEAD_CARD_TITLE,
    feastLine: `Thanksgiving is ${m.feastDayName}${feastDate ? `, ${feastDate}` : ""}.`,
    days: out.filter((d) => d.when !== "past").map(strip),
    doneDays,
    doneDaysLine: doneDays.length > 0 ? `Done days (${doneDays.length})` : null,
    emptyLine: out.length === 0 ? "Chop everything for the feast in one go, the day before." : null,
  };
}

/**
 * Prep the Week's title and its one quiet line, by session. The feast session is
 * the same screen with its own title, labelled with its day; the week, when the
 * plan has a feast, says where the feast's prep went.
 */
export function prepSessionCopy(opts: {
  session?: "feast";
  isSubset: boolean;
  /** The feast session's day, from the server ("Wednesday"). */
  sessionDay?: string;
  /** WEB-4b (BUG-455) — THX-3: the day the session must be done BEFORE ("Monday",
   *  the first day a make-ahead dish uses one of its mixes). Wins when present. */
  sessionBefore?: string;
  /** GET /plans/:id carried `makeAhead`: the plan holds a feast. */
  planHasFeast: boolean;
}): { title: string; notice: string | null } {
  if (opts.session === "feast") {
    // WEB-4b (BUG-455) — the session holds Monday's and Tuesday's mixes too, so
    // "for Wednesday" was false. An older server sends no sessionBefore.
    const notice = opts.sessionBefore
      ? `Do this before ${opts.sessionBefore}.`
      : `For ${opts.sessionDay ?? "Wednesday"}, the day before the feast.`;
    return { title: PREP_THE_FEAST_LABEL, notice };
  }
  return {
    title: opts.isSubset ? "Prep Selected Meals" : "Prep the Week",
    notice: opts.planHasFeast ? FEAST_HAS_OWN_PREP_LINE : null,
  };
}
