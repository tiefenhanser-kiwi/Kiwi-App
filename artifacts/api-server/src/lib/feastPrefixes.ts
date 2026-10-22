// THX-3d (F, R6) — A FEAST DISH'S DAYS, READ FROM ITS STEPS AS WELL AS ITS TAGS.
//
// The make-ahead rows (makeAheadSchedule) and Prep the feast's days (the loader's
// makeAheadDays) read the dish TAGS only — THX-2G-E's contract, written by code from
// targets.json. Small's model wrote make-ahead steps the targets never asked for
// (the breast's herb butter and overnight rest, the gravy's stock, the stuffing's
// Tuesday bread, the crisp's assembly): no tag, so no row, while Thursday's Cook Mode
// filters them out by their prefix. They were in no screen at all. A dish added to a
// feast carries prefixes and no tags the same way. So the step phrases — the ones
// Cook Mode already splits the days by (mealTiming onTheDaySteps, the client's
// feastDay) — are read too.
//
//   "Make ahead (Wednesday):"        a make day
//   "Make ahead (Wednesday night):"  a night (the brine's)
//   "Thaw (start Tuesday):"          the thaw

const DAY_SHORT: Record<string, string> = {
  sunday: "sun", monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri", saturday: "sat",
};
const MAKE_AHEAD = /^\s*make ahead \(\s*([a-z]+)(\s+night)?\s*\)\s*:/i;
const THAW = /^\s*thaw \(\s*start\s+([a-z]+)\s*\)\s*:/i;

export interface PrefixDays {
  /** Make days, in step order ("wed"). */
  make: string[];
  /** Night days (the brine's), in step order. */
  night: string[];
  /** The thaw's start day, or null. */
  thaw: string | null;
}

/** The days a dish's steps name, by THX-2G-F's phrases. */
export function prefixDaysOf(texts: readonly string[]): PrefixDays {
  const out: PrefixDays = { make: [], night: [], thaw: null };
  for (const t of texts) {
    const m = MAKE_AHEAD.exec(t);
    if (m) {
      const day = DAY_SHORT[m[1].toLowerCase()];
      const list = m[2] ? out.night : out.make;
      if (day && !list.includes(day)) list.push(day);
      continue;
    }
    const th = THAW.exec(t);
    if (th && out.thaw === null) out.thaw = DAY_SHORT[th[1].toLowerCase()] ?? null;
  }
  return out;
}
