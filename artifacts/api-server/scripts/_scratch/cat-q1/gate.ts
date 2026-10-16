// CAT-Q1 Part C — the gate a patch passes before it is accepted. Pure.
//
//   Pass 1   CAT-Q0's code checks re-run on the patched meal: a finding of a
//            numbered class (1–7) the unpatched meal did not have → reject.
//   review   CAT-Q0's rubric re-run on the patched meal (same cached prefix).
//            Every block/fix issue it returns must be one that was already
//            there and NOT answered by the patch:
//              matches an answered issue      → reject ("still there")
//              matches an unanswered issue,
//                or the baseline review       → allowed (not this patch's)
//              matches nothing                → reject ("new")
//            The baseline is the CAT-Q0 review of the payload the patch was
//            planned on when that review exists (production, unmoved); else a
//            fresh review of it with the same rubric (dev, or a moved payload).
//   sous vide  a doneness issue on a sous vide dish whose bath meets the FSIS
//            table and whose patched bath step carries the safety sentence is
//            the ruling's, not a defect (§1) — set aside, listed.
import type { CatMeal } from "../cat-q0/catalogDb";
import { CLASS_OF, checkMeal, type Finding, type Vocab } from "../cat-q0/checks";
import type { ReviewIssue } from "../cat-q0/rubric";
import type { Q0Issue } from "./issues";
import { checkSousVide, SAFETY_SENTENCE } from "./sousVide";

export interface IssueLike { dish: string; class: number; severity: string; stepIndex: number | null; ingredient: string | null; quote: string }

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[“”"'.,;:()]/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
function overlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** Same underlying problem: same dish and class, and the same step, the same line, or most of the quote. */
export function sameIssue(a: IssueLike, b: IssueLike): boolean {
  if (norm(a.dish) !== norm(b.dish) || a.class !== b.class) return false;
  if (a.stepIndex != null && a.stepIndex === b.stepIndex) return true;
  if (a.ingredient && b.ingredient && norm(a.ingredient) === norm(b.ingredient)) return true;
  return overlap(a.quote, b.quote) >= 0.5;
}

const key = (f: Finding) => `${f.code}|${f.dish}|${f.where}`;
export function pass1New(before: CatMeal, after: CatMeal, vocab: Vocab): Finding[] {
  const had = new Set(checkMeal(before, vocab).map(key));
  return checkMeal(after, vocab).filter((f) => typeof CLASS_OF[f.code] === "number" && !had.has(key(f)));
}

/** A doneness issue the sous vide ruling covers on the PATCHED meal. */
export function ruledSousVide(patched: CatMeal, i: IssueLike): boolean {
  if (i.class !== 5) return false;
  const d = patched.dishes.find((x) => norm(x.title) === norm(i.dish)) ?? (patched.dishes.length === 1 ? patched.dishes[0] : undefined);
  if (!d) return false;
  const c = checkSousVide(d);
  if (!c || !c.meets) return false;
  const said = d.steps.filter((s) => c.steps.includes(s.stepIndex)).some((s) => SAFETY_SENTENCE.test(s.text));
  return said && (i.stepIndex == null || c.steps.includes(i.stepIndex) || /°F/.test(i.quote));
}

export interface GateResult {
  ok: boolean; reasons: string[]; allowed: ReviewIssue[]; ruled: ReviewIssue[]; verdictAfter: string;
  /** Block/fix issues the re-review raised that match nothing known — what a second round answers. */
  fresh: ReviewIssue[];
  /** Answered issues the re-review still finds — the patch failed at its own job. */
  still: ReviewIssue[];
}

export function reviewGate(args: {
  patched: CatMeal;
  issues: ReadonlyArray<IssueLike & { n: number }>;
  answered: ReadonlySet<number>;
  baseline: readonly ReviewIssue[];
  after: { verdict: string; issues: ReviewIssue[] };
}): GateResult {
  const reasons: string[] = [];
  const allowed: ReviewIssue[] = [];
  const ruled: ReviewIssue[] = [];
  const fresh: ReviewIssue[] = [];
  const still: ReviewIssue[] = [];
  const answered = args.issues.filter((i) => args.answered.has(i.n));
  const open = args.issues.filter((i) => !args.answered.has(i.n));
  const base = args.baseline.filter((i) => i.severity !== "polish");
  for (const r of args.after.issues) {
    if (r.severity === "polish") continue;
    if (ruledSousVide(args.patched, r)) { ruled.push(r); continue; }
    const was = answered.find((o) => sameIssue(r, o));
    if (was) { still.push(r); reasons.push(`answered issue ${was.n} is still there: [${r.severity} · class ${r.class}] ${r.dish}${r.stepIndex != null ? ` step ${r.stepIndex}` : ""} — "${r.quote}" — ${r.why}`); continue; }
    if (open.some((o) => sameIssue(r, o)) || base.some((o) => sameIssue(r, o) && !answered.some((a) => sameIssue(o, a)))) { allowed.push(r); continue; }
    fresh.push(r);
    reasons.push(`new ${r.severity}: [class ${r.class}] ${r.dish}${r.stepIndex != null ? ` step ${r.stepIndex}` : ""}${r.ingredient ? ` · "${r.ingredient}"` : ""} — "${r.quote}" — ${r.why}`);
  }
  return { ok: reasons.length === 0, reasons, allowed, ruled, verdictAfter: args.after.verdict, fresh, still };
}

/**
 * Follow-up B — one second round, and only for a REAL new issue: the re-review
 * raised a new block/fix and every answered issue is gone. A patch that failed
 * at its own job ("still there") is rejected, not retried.
 */
export function wantsSecondRound(g: GateResult): boolean {
  return !g.ok && g.fresh.length > 0 && g.still.length === 0;
}

/**
 * Round 2 exists because round 1's re-review failed. A round-2 editor that
 * declines every new issue (no edits, nothing rejected) has fixed nothing, so
 * the meal is rejected — never accepted on round 1's edits.
 */
export function roundTwoDeclined(round: number, edits: number, rejections: number): string | null {
  return round === 2 && edits === 0 && rejections === 0 ? "round 2: the editor declined every new issue — round 1's re-review reasons stand" : null;
}

/** The re-review's new issues as editor issues, numbered after the meal's own. */
export function secondRoundIssues(fresh: readonly ReviewIssue[], first: readonly Q0Issue[], meal: { id: string; title: string }): Q0Issue[] {
  let n = Math.max(0, ...first.map((i) => i.n));
  return fresh.map((r) => ({
    n: ++n, mealId: meal.id, title: meal.title, verdict: "fix", featured: "", class: r.class, severity: r.severity, dish: r.dish,
    where: [r.ingredient ? `ingredient "${r.ingredient}"` : "", r.stepIndex != null ? `step ${r.stepIndex}` : ""].filter(Boolean).join(" · "),
    quote: r.quote, why: r.why, fix: r.fix, ingredient: r.ingredient, stepIndex: r.stepIndex,
  }));
}
