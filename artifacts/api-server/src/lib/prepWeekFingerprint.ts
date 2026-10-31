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
 * Part J.1 — THE ENGINE'S VERSION, IN THE GATE. The cached prose names containers
 * the engine chose ("Fish Tacos pico de gallo bowl", "… dried-chile bag"), and the
 * gate compared only the composition and the prompt version — so a change to how
 * the engine NAMES or GROUPS served the old names from every warm cache until the
 * plan changed (Part I measured the gap; J.1 renamed containers and hit it). Bump
 * this whenever the narration input changes for the same composition: one
 * regeneration per plan, the same price as a prompt bump.
 *   2 — J.1: R2 container names, toppings plates, component raw mixes, protein
 *       portion steps, dash labels spoken in words.
 *   3 — J.1: count totals take the count's number ("3 yellow onions").
 *   4 — J.1b: a protein's knife verbs come only from sentences that name it.
 *   5 — J.1c: single-dish lids named by class (juice jar, toppings plate, vegetables,
 *       aromatics), container names fitted to the wire in whole words (BUG-354),
 *       proteins timed by their verb, a hyphenated weight is not "pound".
 *   6 — J.1c, after its first regeneration: a garnish is what a dish is garnished
 *       WITH (the roasted asparagus went on a toppings plate under v5), and several
 *       lone cuts of one dish share its prep plate. The cached `containerNames` are
 *       not recomputed on read, so a name change needs the bump, not just the code.
 *   7 — SRV-1 (BUG-358): a container holds one mixture for one moment — a
 *       component's members split by the step they enter at, a food's name in
 *       prose ("soy sauce") no longer makes a mixture noun. BUG-359 rides the same
 *       bump (nothing cached v7 in between): lids keep every word of their dish and
 *       never double the container word, a dish's own toppings go on its plate.
 *   8 — PREP-1 (BUG-413): an engine-demoted step is off the wire and its dish's
 *       recipe off the narration input; a phase over 30 steps sends its overflow
 *       to the cook-day list before narration.
 *   9 — PREP-2 item 4: "per pound" is a rate, not the verb, and a whole bird or a
 *       large roast is never pounded. The protein's knife verbs are narration input
 *       ("Pound the 14 lb whole turkey … to even thickness" was cached on every
 *       feast session), so the cached prose must go.
 *  10 — THX-3: every amount the narrator echoes is FIX-7's displayed number
 *       (BUG-444: "4.8 cloves" → "5 cloves", ⅞ tbsp → 1 tbsp); water, ice and
 *       equipment are never measured and extract, purée and fresh produce filed as
 *       Pantry are never dry (BUG-426/447); a feast's salt and pepper join its dry
 *       mixes, and a make-ahead dish brings only its shelf-stable mix to "Prep the
 *       feast" (D-WS9-316). All change containers and amounts, so the prose must go.
 *  11 — THX-3b: a whole-bird dish scales by its bird and a neck or giblets is one
 *       (BUG-454: the brine at 4 of 10 servings was ¼ cup salt in ⅜ gallon, now ⅓
 *       cup in ¾); an ingredient a dish lists twice at two moments is two portions,
 *       each in its own step's container (BUG-456: the casserole's topping sugar left
 *       the filling's mix; 55 of the 158 catalog meals with such a dish change).
 *       Amounts and containers both move, so the prose must go.
 *  12 — THX-3c: a make-ahead feast dish's produce cuts are back in Prep the feast,
 *       held to the DISH's own day (Hans, October 20; Make-Ahead 5 → 14 produce
 *       steps); smashed garlic, thyme leaves and garnish herbs are feast knife work;
 *       a feast mix of whole spices alone keeps the floor of three (G); stalks and
 *       ribs print whole, equipment as written, a bird by count is whole birds, and
 *       an all-dry container is never a "marinade bowl" (C, A). Containers, amounts
 *       and names move, so the prose must go.
 *  13 — THX-3c follow-up: a dish follows a bird written by count only in a feast
 *       (Chicken Pho at household 2 is a half pot again); a citrus zested and juiced
 *       is one cut ("Zest and juice the orange"); a feast garnish rule 7 drops gets a
 *       cook-day line. Amounts, titles and lines move, so the prose must go.
 *  14 — THX-3d: a feast dry mix is three or more (never salt and pepper alone), a
 *       seasoning joins by the step's words, another vessel is another run, a lone
 *       dry member goes in with its liquids; closers name the step and print their
 *       share; the R5 display table (ounces, produce heads, packages "use N oz");
 *       a count-written bird with its weight takes the weight rule in a feast;
 *       make-ahead rows read the steps' day phrases. Containers, amounts and lines
 *       move, so the prose must go.
 *  15 — THX-3d round 2: Prep the feast's containers carry short labels and the session
 *       opens with "Label N containers" (N); a measure step and a later clause are their
 *       own moments, a juice joins a jar only for its moment, "zested, then juiced" is
 *       both, a cavity's vegetable is trimmed (L); an unscaled amount prints as written
 *       and produce rounds to its half (P). Names, members and amounts move, so the
 *       prose must go.
 *  16 — PREP-3: a weeknight meal's lone cuts are piles on its one plate and every
 *       loose juice is in one tub per fruit (R3); a marinade's oil, salt, pepper and
 *       fresh herb are measured into its jar (R4); equipment is never measured (R8);
 *       one moment per jar member — a brushed-on Dijon, the croutons' oil, a pan's
 *       searing oil leave the jars they were in (R9). Containers, members and names
 *       move, so the prose must go.
 *  17 — THX-3d round 4 (BUG-510, D-WS9-299): a protein patted dry and nothing else is
 *       no Prep the Week step even when it meets a marinade on cook day (its join stays
 *       the marinade's cook-day line), and "skin-on" / "skin-side down" is not skinning.
 *       Measured on hans+8's 172 dev plans: 39 protein steps leave the week (salmon,
 *       skin-on thighs and breasts, the Nashville Hot tenderloins), none join it. Steps
 *       and numbers move, so the prose must go.
 */
export const PREP_ENGINE_VERSION = 17;

/**
 * SERVER-13 C (D-WS9-372) — THE WEEKNIGHT SESSION'S VERSION, IN THE WEEK'S GATE ONLY.
 * PREP_ENGINE_VERSION is in both gates (above and feastSessionFingerprint), so bumping
 * it to refresh the weeknights re-narrates every "Prep the feast" session too. Bump
 * this instead when only Prep the Week's narration input changes for the same
 * composition; the feast's cache is left alone.
 *   1 — SERVER-12 B (BUG-619) and C (BUG-623): a divided row is a portion per step
 *       (346 of the 1,337 weeknight catalog meals hold such a dish, and their plans'
 *       fingerprints had already moved) and a scaled amount under ¼ cup is said in
 *       spoons (no fingerprint moved). One bump so both refresh on the same next open:
 *       every warm weeknight cache re-narrates once (one prep.narrate_steps call).
 */
export const WEEK_SESSION_VERSION = 1;

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
    .update(JSON.stringify({ v: FINGERPRINT_ALGO_VERSION, engine: PREP_ENGINE_VERSION, week: WEEK_SESSION_VERSION, input }))
    .digest("hex");
}

/**
 * PREP-1 G — the feast session's version, in its own gate. Bump it when the feast
 * session's build changes for the same feast (it shares PREP_ENGINE_VERSION too).
 *   1 — built from the feast meals alone (feastOnlyLoad), not the whole plan scoped.
 *   2 — THX-3d 3b: a tub of a citrus both zested and juiced is "Orange zest and juice"
 *       (production's New Twist read "And juiced orange zest"). Labels move, so the
 *       feast sessions' prose must go; the weeknight weeks build no feast labels.
 */
export const FEAST_SESSION_VERSION = 2;

/**
 * PREP-1 G — "Prep the feast"'s cache gate: the FEAST'S OWN inputs (its meals —
 * dishes, ingredients, servings — under its own name), the engine version and the
 * session version. Never the weeknights: the session is built from the feast alone
 * (prepWeekBuild.feastOnlyLoad), so a weeknight swap cannot change what it would
 * narrate, and QA-1 measured each needless re-narration at $0.047.
 */
export function feastSessionFingerprint(feastInput: PrepLoadedPlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: FINGERPRINT_ALGO_VERSION, engine: PREP_ENGINE_VERSION, session: FEAST_SESSION_VERSION, input: feastInput }))
    .digest("hex");
}
