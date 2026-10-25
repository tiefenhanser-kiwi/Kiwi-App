// THX-3d round 4 (BUG-507, the server half) — A PUT-IN SAYS WHAT GOES IN NEXT (content,
// patch.ts, no AI).
//
// Consecutive oven put-ins did not say what follows: the cook put the sweet potatoes in
// and was not told the green beans go in 15 minutes later. After the put-in steps are
// written (thx2Thursday's raise, thx2PutIn's own steps), the day is scheduled again and
// any put-in — the raise, "Put the … in the oven with the turkey", a side's own "Put the
// … in the oven." — that another put-in follows within NEXT_WITHIN minutes gains one
// clause, the gap rounded to 5:
//   "Put the sweet potatoes in the oven now that the turkey breast is out; the green beans go in 15 minutes from now."
// Beyond that, nothing (the client's "Next step in N minutes" covers it). Never a clock
// time (D-WS9-320: no serving-time target, ever). A dish the raise already says goes in
// when the bird comes out is not announced twice. Idempotent: the clause is rewritten.
import { PUT_IN_ONE, RAISE_AND_PUT_IN, raiseHead, raiseWaits } from "../../src/lib/cookingScheduler";
import { thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";

/** Minutes within which the next put-in is announced. */
export const NEXT_WITHIN = 30;
/** The clause, as written: "; the green beans go in 15 minutes from now". */
const NEXT_CLAUSE = /;\s*the [^;]+? go(?:es)? in \d+ minutes from now(?=[;.]|$)/i;

const pluralNoun = (noun: string) => /(?:[^s]s|ies|oes)$/i.test(noun.split(/\s+/).pop() ?? "") && !/(?:ss|us)$/i.test(noun);

/** What a put-in step puts in, as the cook says it: "the sweet potatoes", "the Sage Stuffing and Apple Crisp". */
function whatGoesIn(text: string): string | null {
  const body = text.replace(/^\s*On [A-Za-z]+day:\s*/, "");
  const raise = /^Raise the oven to \d{3}\s*°\s*F and put in (the .+)$/i.exec(raiseHead(body).replace(/\.$/, ""));
  if (raise) return raise[1];
  const put = /^Put (the .+?) in the oven\b/i.exec(body);
  return put ? put[1] : null;
}

/** The text with its forward clause set to `clause` (or removed when null). */
export function withNextClause(text: string, clause: string | null): string {
  const bare = text.replace(NEXT_CLAUSE, "");
  if (!clause) return bare;
  return bare.replace(/\.\s*$/, `; ${clause}.`);
}

/** The forward clause each put-in should carry, as text updates (only the ones that change). */
export function nextPutInEdits(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): { dishId: string; stepIndex: number; text: string }[] {
  const { schedulerDishes, result } = thursdaySchedule(dishes, steps);
  const textOf = new Map(schedulerDishes.flatMap((d) => d.steps.map((s) => [`${d.dishId}#${s.stepIndex}`, s.text ?? ""] as const)));
  const putIns = result.steps
    .map((e) => ({ e, text: textOf.get(`${e.dishId}#${e.originalStepIndex}`) ?? "" }))
    .filter((x) => RAISE_AND_PUT_IN.test(x.text) || PUT_IN_ONE.test(x.text))
    .sort((a, b) => a.e.startOffsetMinutes - b.e.startOffsetMinutes || a.e.sequenceIndex - b.e.sequenceIndex);
  const out: { dishId: string; stepIndex: number; text: string }[] = [];
  putIns.forEach((p, i) => {
    const next = putIns.slice(i + 1).find((q) => q.e.dishId !== p.e.dishId && q.e.startOffsetMinutes > p.e.startOffsetMinutes);
    const gap = next ? Math.round((next.e.startOffsetMinutes - p.e.startOffsetMinutes) / 5) * 5 : 0;
    const what = next ? whatGoesIn(next.text) : null;
    const named = what && next ? raiseWaits(p.text).includes(schedulerDishes.find((d) => d.dishId === next.e.dishId)?.title ?? "\u0000") : false;
    const clause = next && what && !named && gap >= 5 && next.e.startOffsetMinutes - p.e.startOffsetMinutes <= NEXT_WITHIN ? `${what} ${pluralNoun(what) || / and /.test(what) ? "go" : "goes"} in ${gap} minutes from now` : null;
    const want = withNextClause(p.text, clause);
    if (want !== p.text) out.push({ dishId: p.e.dishId, stepIndex: p.e.originalStepIndex, text: want });
  });
  return out;
}
