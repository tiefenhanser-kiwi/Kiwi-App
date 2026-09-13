// WS9 D-WS9-239 Phase 1b — `firstDependent` → `parallelGroup` derivation.
//
// The step generators (wizard.candidate.expand's outline, the two finalize_steps
// calls) declare, per UNATTENDED step, the index of the FIRST later step that
// cannot begin until it has completely finished (`firstDependent`; null = no
// later step needs it). This module turns those END-explicit windows into the
// `parallelGroup` tokens the scheduler honours (cookingScheduler.ts, Phase 1a).
//
// ⚠️ WHY THE WIRE CARRIES `firstDependent` AND NOT `parallelGroup` — measured,
// do not re-litigate here. Phase 0 asked the model to write tokens directly
// (Encoding A) and it placed the window END wrong on 31% of tagged dishes
// (Sonnet) / 61% (Haiku), every error in the dangerous direction (a step that
// USES the window's product tagged to ride it). Phase 0b asked instead "which
// is the FIRST later step that cannot start until this one is completely done?"
// (Encoding B) and the wrong-window rate fell to 0% tuned / 14% untuned / 7%
// pooled. The storage contract is unchanged (tokens on RecipeInstructionStep);
// only how the tokens are OBTAINED changed. `parallelGroup` is therefore NEVER
// a model-written field: it does not appear on any tool schema, and every
// generator seam sets it from this module's output.
//
// This is a PORT of the Phase 0b probe's `deriveFromWindows` + `normalizeTags`
// (scripts/ws9-239/common.ts) — the code the measured numbers came from. The
// one translation: the probe keyed on the stored `stepIndex`; a generator's
// output is an ordinal array, so the index here is the ARRAY POSITION, and a
// token is `w<position>`. The rules, in the order they run:
//   (a) a window must be UNATTENDED (the scheduler's own predicate — one
//       predicate, two callers, never a second copy);
//   (b) a `rest`/`hold` IMMEDIATELY after a `cook` window closes the window AT
//       the rest — the model's END was wrong (a rest cannot start when its own
//       cook is kicked off);
//   (c) contiguity — riders are the unbroken run after the window; a hole
//       closes the group;
//   (d) rider and window share `pathKey`, or one is base (null).
// A step inside two open windows goes to the EARLIEST (tie-break, counted). A
// window with no riders emits no token. A missing `firstDependent` on an
// unattended step means "the next step depends" (no token — the conservative
// reading). `firstDependent` on an ATTENDED step is IGNORED and reported (the
// model was told not to write it there); a value that is not later, out of
// range, or not an integer is reported and emits no token. The assignment
// iterates to a fixpoint: a window whose whole group collapses under the rules
// is removed so the windows it had absorbed get their turn.
//
// Pure: no logger (callers log the issues under their own event name), no
// Prisma types, no I/O.

import { isUnattended, type SchedulerPhase } from "./cookingScheduler";

/** One generator-output step, in dish order. Only the fields the rules read. */
export interface DeriveStep {
  phaseType: SchedulerPhase;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
  componentKey?: string | null;
  pathKey?: string | null;
  // Absent = the model wrote nothing; null = "no later step needs this".
  firstDependent?: number | null;
}

export type DeriveIssueClass =
  // `firstDependent` on an attended step — ignored, never a token.
  | "attended_window"
  // Not an integer, negative, or ≥ the step count.
  | "dependent_out_of_range"
  // Points at itself or an earlier step.
  | "dependent_not_later"
  // An unattended step with no entry — treated as "next step depends".
  | "missing_window"
  // Rule (b): the dependent skipped the rest/hold right after a cook window;
  // the window was closed at the rest.
  | "rest_rides_cook"
  // Report-only: a rest/hold rides a cook window it is NOT adjacent to.
  | "rest_rides_cook_nonadjacent"
  // Report-only: the window sits inside an earlier window; its own riders
  // stay with the earlier one (the tie-break).
  | "nested_window_absorbed"
  // Rule (d): the rider's pathKey differs from the window's, neither base.
  | "path_mismatch"
  // A window left with no riders after the rules (harmless, reported).
  | "lone_token"
  // Contiguity: a token re-appeared after its group closed.
  | "reopened_group"
  // The fixpoint removed a window that lost every rider.
  | "window_collapsed";

export interface DeriveIssue {
  cls: DeriveIssueClass;
  detail: string;
}

export interface DeriveResult {
  // One entry per input step: the token, or null (untagged).
  tags: (string | null)[];
  issues: DeriveIssue[];
  // Steps a second open window wanted; they went to the earliest.
  tieBreaks: number;
  // How many steps carried a `firstDependent` at all (integer or null). Zero
  // means the generator declared nothing for this dish — an old prompt, or a
  // model that ignored the field — which callers treat as silent (every
  // unattended step reports `missing_window`, and logging that per dish would
  // be noise, not a rule rejection).
  declaredCount: number;
}

type Step = DeriveStep;

/**
 * Rule 4 of the token contract, as the probe applied it: drop invalid groups →
 * untagged. Returns the kept tags + every drop. (Ported verbatim; two of its
 * branches — attended window, reopened group — cannot fire on tags this module
 * itself assigned, but the fixpoint below depends on its lone-token pass.)
 */
function normalizeTags(
  steps: Step[],
  tags: (string | null)[],
): { tags: (string | null)[]; dropped: DeriveIssue[] } {
  const dropped: DeriveIssue[] = [];
  const out = [...tags];
  const tokens = [...new Set(out.filter((t): t is string => t !== null))];
  for (const tok of tokens) {
    const idxs = out.map((t, i) => (t === tok ? i : -1)).filter((i) => i >= 0);
    const w = idxs[0];
    if (!isUnattended(steps[w])) {
      dropped.push({
        cls: "attended_window",
        detail: `token "${tok}" first appears on attended step #${w} (${steps[w].phaseType}${steps[w].isTimingSensitive ? ",ts" : ""})`,
      });
      for (const i of idxs) out[i] = null;
      continue;
    }
    if (idxs.length === 1) {
      dropped.push({ cls: "lone_token", detail: `token "${tok}" only on step #${w} (window with no riders — harmless)` });
      out[w] = null;
    }
  }
  // Contiguity: a token that re-appears after its group closed would let a
  // later step start before the untagged step that closed the group.
  let open: string | null = null;
  const closed = new Set<string>();
  for (let k = 0; k < out.length; k++) {
    const t = out[k];
    if (t === null) {
      if (open !== null) closed.add(open);
      open = null;
      continue;
    }
    if (t !== open) {
      if (open !== null) closed.add(open);
      if (closed.has(t)) {
        dropped.push({ cls: "reopened_group", detail: `token "${t}" re-appears on step #${k} after its group closed` });
        out[k] = null;
        open = null;
        continue;
      }
      open = t;
    }
  }
  // A window left with no riders after the drops is harmless → plain.
  for (const tok of [...new Set(out.filter((t): t is string => t !== null))]) {
    const idxs = out.map((t, i) => (t === tok ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 1) {
      dropped.push({ cls: "lone_token", detail: `token "${tok}" only on step #${idxs[0]} after contiguity drop` });
      out[idxs[0]] = null;
    }
  }
  return { tags: out, dropped };
}

/**
 * Derive one dish's `parallelGroup` tokens from its steps' `firstDependent`
 * declarations. `steps` is the dish's steps IN ORDER; index = array position.
 */
export function deriveParallelGroups(steps: Step[]): DeriveResult {
  const issues: DeriveIssue[] = [];
  const n = steps.length;
  const unattendedIdx = steps.map((s, i) => (isUnattended(s) ? i : -1)).filter((i) => i >= 0);
  const declaredCount = steps.filter((s) => s.firstDependent !== undefined).length;

  // window → exclusive end (index of the first dependent; n when null)
  const ends = new Map<number, number>();
  const seen = new Set<number>();
  for (let wi = 0; wi < n; wi++) {
    const fd = steps[wi].firstDependent;
    if (fd === undefined) continue; // no entry
    seen.add(wi);
    if (!isUnattended(steps[wi])) {
      issues.push({
        cls: "attended_window",
        detail: `#${wi} is attended (${steps[wi].phaseType}${steps[wi].isTimingSensitive ? ",ts" : ""}); its firstDependent (${fd}) is ignored`,
      });
      continue;
    }
    if (fd === null) {
      ends.set(wi, n);
      continue;
    }
    if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0 || fd >= n) {
      issues.push({ cls: "dependent_out_of_range", detail: `#${wi} → ${String(fd)}` });
      continue;
    }
    if (fd <= wi) {
      issues.push({ cls: "dependent_not_later", detail: `#${wi} → #${fd}` });
      continue;
    }
    ends.set(wi, fd);
  }
  for (const ui of unattendedIdx) {
    if (!seen.has(ui)) {
      issues.push({ cls: "missing_window", detail: `unattended #${ui} has no entry (treated as: next step depends)` });
    }
  }

  // Rule (b): a rest/hold at w+1 riding a cook window w → close the window at the rest.
  for (const [wi, end] of [...ends]) {
    const nxt = steps[wi + 1];
    if (end > wi + 1 && steps[wi].phaseType === "cook" && nxt && (nxt.phaseType === "rest" || nxt.phaseType === "hold")) {
      issues.push({
        cls: "rest_rides_cook",
        detail: `#${wi} (cook) → dependent #${end < n ? end : "end"} skips the rest/hold at #${wi + 1}; closed at the rest`,
      });
      ends.set(wi, wi + 1);
    } else if (end > wi + 1 && steps[wi].phaseType === "cook") {
      // Report-only: a rest/hold riding a NON-adjacent cook window.
      for (let k = wi + 2; k < end; k++) {
        if (steps[k].phaseType === "rest" || steps[k].phaseType === "hold") {
          issues.push({ cls: "rest_rides_cook_nonadjacent", detail: `#${k} rides cook #${wi}` });
          break;
        }
      }
    }
  }

  // Assign tokens: earliest open window wins. Iterated to a fixpoint: a window
  // whose group collapses under the structural rules (path hole → contiguity,
  // no riders) is removed and the windows it had absorbed get their turn.
  // Deterministic; still "earliest surviving window wins".
  let tieBreaks = 0;
  const active = new Map(ends);
  let tags: (string | null)[] = [];
  let normIssues: DeriveIssue[] = [];
  const seenIssue = new Set<string>();
  const keep = (i: DeriveIssue) => {
    const k = i.cls + "|" + i.detail;
    if (!seenIssue.has(k)) {
      seenIssue.add(k);
      issues.push(i);
    }
  };
  for (let iter = 0; iter < 20; iter++) {
    tags = new Array<string | null>(n).fill(null);
    normIssues = [];
    tieBreaks = 0;
    const ordered = [...active].sort((a, b) => a[0] - b[0]);
    for (const [wi, endI] of ordered) {
      const tok = `w${wi}`;
      if (endI <= wi + 1) continue; // no riders → no token (harmless)
      if (tags[wi] !== null) {
        tieBreaks++;
        normIssues.push({
          cls: "nested_window_absorbed",
          detail: `#${wi} rides an earlier window; its own ${endI - wi - 1} rider(s) not tagged`,
        });
        continue;
      }
      tags[wi] = tok;
      for (let k = wi + 1; k < endI; k++) {
        if (tags[k] !== null) {
          tieBreaks++;
          continue;
        }
        const pw = steps[wi].pathKey ?? null;
        const pk = steps[k].pathKey ?? null;
        if (pw !== null && pk !== null && pw !== pk) {
          normIssues.push({ cls: "path_mismatch", detail: `#${k} (${pk}) cannot ride #${wi} (${pw})` });
          continue;
        }
        tags[k] = tok;
      }
    }
    const norm = normalizeTags(steps, tags);
    for (const d of norm.dropped) normIssues.push(d);
    // Which windows lost their whole group? Remove them and go again.
    const survivors = new Set(norm.tags.filter((t): t is string => t !== null));
    let removed = false;
    for (const [wi, endI] of active) {
      if (endI > wi + 1 && tags[wi] !== null && tags[wi] === `w${wi}` && !survivors.has(tags[wi] as string)) {
        active.delete(wi);
        removed = true;
        normIssues.push({ cls: "window_collapsed", detail: `#${wi} lost every rider to the rules; removed so inner windows may form` });
      }
    }
    for (const i of normIssues) keep(i);
    tags = norm.tags;
    if (!removed) break;
  }
  return { tags, issues, tieBreaks, declaredCount };
}
