// PREP-1 (D-WS9-314) — the Hub's "Thanksgiving make-ahead" card, as a pure model.
//
// The server sends the schedule as data (GET /plans/:id `makeAhead`, built from
// the feast dishes' tags and the plan's dates); the words are written here, so
// the copy ships over the air. Rows are grouped by day in the server's order —
// a brine is its day's NIGHT, so it gets a group of its own after the day's
// make-ahead work ("Wednesday night").

import type { MakeAhead, MakeAheadRow } from "@/lib/api/plans";

export const MAKE_AHEAD_CARD_TITLE = "Thanksgiving make-ahead";
export const PREP_THE_FEAST_LABEL = "Prep the feast";
/** Prep the Week's one line when the plan has a feast (the week no longer covers it). */
export const FEAST_HAS_OWN_PREP_LINE = "The feast has its own prep. See Thanksgiving make-ahead.";

export interface MakeAheadRowVM {
  key: string;
  /** The dish the row is about (meal detail has no per-dish anchor to scroll to). */
  dishId: string;
  /** The recipe link: the feast meal, opened in plan context. */
  mealId: string;
  planItemId: string | null;
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

/**
 * PREP-1 F — where a make-ahead row goes: the FEAST MEAL's detail in plan context,
 * so every recipe in it reads at the plan's servings (the ×10 the feast is cooked
 * for). The dish screen reads the dish's own default — 4 — and a cook following it
 * makes too little. Without a plan item (an older server) it is the meal alone.
 */
export function makeAheadRecipeRoute(
  planId: string,
  row: Pick<MakeAheadRowVM, "mealId" | "planItemId">,
): { pathname: "/meal/[id]"; params: { id: string; planId?: string; planItemId?: string } } {
  return row.planItemId && planId
    ? { pathname: "/meal/[id]", params: { id: row.mealId, planId, planItemId: row.planItemId } }
    : { pathname: "/meal/[id]", params: { id: row.mealId } };
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
      key: `${row.kind}-${row.dishId}`,
      dishId: row.dishId,
      mealId: row.mealId,
      planItemId: itemId,
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
  /** GET /plans/:id carried `makeAhead`: the plan holds a feast. */
  planHasFeast: boolean;
}): { title: string; notice: string | null } {
  if (opts.session === "feast") {
    return { title: PREP_THE_FEAST_LABEL, notice: `For ${opts.sessionDay ?? "Wednesday"}, the day before the feast.` };
  }
  return {
    title: opts.isSubset ? "Prep Selected Meals" : "Prep the Week",
    notice: opts.planHasFeast ? FEAST_HAS_OWN_PREP_LINE : null,
  };
}
