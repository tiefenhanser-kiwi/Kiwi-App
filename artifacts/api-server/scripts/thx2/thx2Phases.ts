// THX-3d round 2 (H) — A TWO-PHASE BAKE OR ROAST IS TWO TIMED STEPS (content, patch.ts).
//
// Hans's lens: a cook with no experience sees only the step in front of them. "Bake the
// stuffing covered for 30 minutes, then uncover and bake 20–25 minutes more" is one step
// with one timer, and the moment to uncover has no step of its own. Split at the phase
// change, each half carrying its own minutes, so the scheduler times both and a timer
// fires when the foil comes off:
//   "Bake covered for 30 minutes, then uncover and bake 20–25 minutes more until golden"
//     → "Bake covered for 30 minutes." · "Uncover and bake 20–25 minutes more until golden."
//   "roast at 425°F for 20 minutes to brown the skin, then reduce the oven to 325°F and
//    continue roasting for about 30 minutes" → two steps.
//   "Roast 20 minutes; scatter the Parmesan and roast 5–8 minutes more" → two steps.
// Both halves keep the day prefix. A second half that is not in the oven ("; cool at
// least 20 minutes before serving") is not a phase: no split. Idempotent: each half
// states one duration.

const DAY_PREFIX = /^(\s*(?:Make ahead \([A-Za-z]+(?: night)?\)|On [A-Za-z]+day|Thaw \(start [A-Za-z]+\))\s*:\s*)/i;
const OVEN = /\b(?:bake|baking|roast|roasting)\b/i;
/** A duration in minutes: "30 minutes", "20–25 minutes", "15 more minutes", "about 30 minutes". */
const DURATION = /(\d+)(?:\s*[–-]\s*(\d+))?\s*(?:more\s+)?min(?:ute)?s?\b/gi;
/** Where the second phase starts: ", then …" or "; …" before an oven verb or the change itself. */
const SEPARATOR = /(?:,\s*then\s+|;\s+(?:then\s+)?)(?=(?:uncover|remove the foil|reduce|lower|raise|increase|scatter|sprinkle|top|brush|baste|continue|bake|roast|turn)\b)/gi;

const durations = (s: string) => [...s.matchAll(DURATION)].map((m) => Number(m[2] ?? m[1]));

export interface PhaseSplit { first: string; second: string; firstMinutes: number; secondMinutes: number }

/** The two phases of a bake or roast step, or null when it has one. */
export function splitTwoPhase(text: string, estimatedMinutes: number): PhaseSplit | null {
  const prefix = DAY_PREFIX.exec(text)?.[1] ?? "";
  const body = text.slice(prefix.length);
  for (const m of body.matchAll(SEPARATOR)) {
    const a = body.slice(0, m.index);
    const b = body.slice(m.index! + m[0].length);
    // The second phase: its own oven verb and minutes, before the sentence ends.
    const bPhase = b.split(/(?<=\.)\s+(?=[A-Z])/)[0];
    if (!OVEN.test(a) || !OVEN.test(bPhase)) continue;
    const da = durations(a);
    const db = durations(bPhase);
    if (da.length !== 1 || db.length < 1) continue;
    const firstMinutes = Math.max(1, da[0]);
    const secondMinutes = Math.max(db[0], estimatedMinutes - firstMinutes);
    const second = b.charAt(0).toUpperCase() + b.slice(1);
    // "On Thursday:" opens the day once; the half after it is still Thursday (mealTiming's
    // runs). A make-ahead half keeps its day: the Hub's rows read it.
    const secondPrefix = /^\s*On /i.test(prefix) ? "" : prefix;
    return {
      first: `${prefix}${a.replace(/[,\s]+$/, "")}.`,
      second: `${secondPrefix}${/[.!]$/.test(second.trim()) ? second.trim() : `${second.trim()}.`}`,
      firstMinutes,
      secondMinutes,
    };
  }
  return null;
}
