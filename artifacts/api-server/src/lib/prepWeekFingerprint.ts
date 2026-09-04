// WS9 — Prep the Week cache invalidation, scoped to COMPOSITION.
//
// THE DEFECT THIS REPLACES
// The cache gate used to be `row.lastGeneratedFromPlanRevisionId === plan.revisionId`.
// `MealPlanInstance.revisionId` bumps on ANY structural edit to the plan — including
// edits the prep payload cannot see. `loadPrepWeekInput` selects
// plan → items → meal → dishLinks → dish → dishIngredients → ingredient → steps and
// reads ZERO date fields: no `assignedDate`, no `dayOfWeek`, no `startDate`/`endDate`.
// So setting a plan's date range could not possibly change the prep structure, yet it
// invalidated the cache and cost a full regeneration (~73 s, ~$0.125).
//
// Observed in the wild on 2026-09-03 (UserActivity + LLMCallLog, plan 3d2fdff3):
//   01:04:06  full-week prep  → cache row created
//   01:17:54  plan_date_range_edited   {from:{startDate:null,endDate:null} → dates}
//   01:18:16  plan_meal_assigned       {day:"Wednesday"}
//   01:18:25  plan_meal_unassigned     {from:"Wednesday"}
//   18:14:59  full-week prep  → MISS, full regeneration, byte-identical 12,916-token
//                               payload to the 01:04 call
// Three revision bumps, every one of them date/day-only, none of them touching a
// single field the payload reads.
//
// THE SHAPE CHOSEN, AND WHY
// A hash of the loader's own output — NOT a second "composition revision" counter.
//
// A counter would need a bump site in every route that mutates plan composition, and
// the hazard runs the wrong way: forget one bump site and the cache serves a stale prep
// plan for a week whose meals have changed. That is strictly worse than the waste being
// fixed. A hash derived from `PrepLoadedPlan` cannot have that failure mode — the value
// IS the payload, so if the meals changed, the loaded input changed, and the fingerprint
// changed. There is nothing to remember to bump.
//
// It also costs nothing: the route already calls `loadPrepWeekInput` BEFORE the cache
// lookup (it needs `planRevisionId` from the same query), so the input is in hand at
// gate time. No extra query, no reordering.
//
// WHY THE WHOLE OBJECT, NOT A CURATED FIELD LIST
// `JSON.stringify(input)` deliberately hashes every field of `PrepLoadedPlan` rather
// than an explicit allowlist. An allowlist is the same forget-a-field hazard as the
// counter, one layer down: add `ingredient.density` to the loader next year, forget to
// add it here, and the cache under-invalidates. Hashing the whole object means any
// field the loader gains automatically joins the gate. The cost is the safe direction —
// a field that does not reach the AI can cause one extra regeneration, never a missed
// one. Key order is stable: `PrepLoadedPlan` is built from object literals with fixed
// string keys, and array order is fixed by the loader's `orderBy` clauses.
//
// PROMPT VERSION IS A SEPARATE, FAIL-OPEN HALF OF THE GATE — NOT PART OF THIS HASH
// The old gate compared only the revision, so a `prep.narrate_steps` body change did
// NOT invalidate a cached structure — every already-cached plan kept serving prose
// written by the previous prompt version, indefinitely. The route now also compares
// `PrepWeekStructure.promptVersion` against the active one.
//
// ⚠️ That comparison is deliberately kept OUT of this hash, and deliberately fails
// OPEN. Folding the version into the digest was tried and is wrong: the read gate
// must know the active version BEFORE any AI call, so it resolves the descriptor
// separately, while the write stamps the version that actually narrated. If the
// descriptor lookup fails (DB blip — `resolvePromptDescriptorFromDb` swallows the
// error and returns version `null`), a digest-folded version would differ from the
// stored one on EVERY request and regenerate forever: a silent perpetual-miss bug of
// exactly the class this module exists to remove. Keeping composition in the hash and
// version as a separate `null` -> skip check means a failed lookup degrades to
// composition-only invalidation — never to a permanent cache miss.

import { createHash } from "node:crypto";

import type { PrepLoadedPlan } from "./prepWeekAggregation";

// Bump when the hashed representation itself changes shape (not when the plan
// changes) — it forces one clean regeneration across the fleet rather than
// letting old-format and new-format digests be compared as if equal.
const FINGERPRINT_ALGO_VERSION = 1;

/**
 * Digest of the loaded plan composition — everything the prep payload is built
 * from, and nothing else.
 *
 * Stored on `PrepWeekStructure.compositionFingerprint` and compared on read. A
 * null stored value (every row written before this shipped) is treated as a
 * MISS by the caller — self-healing, one regeneration per plan, no backfill.
 */
export function prepCompositionFingerprint(input: PrepLoadedPlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: FINGERPRINT_ALGO_VERSION, input }))
    .digest("hex");
}
