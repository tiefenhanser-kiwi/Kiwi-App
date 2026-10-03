// WS6 6d-2 — Prep the Week aggregation schemas.
// Per kiwi_ws6_plan.md §3 6d-2 + PRD §13.4.1 / §13.4.3 / §13.4.6.
//
// Server-side endpoint (POST /api/plans/:planId/prep-week) hands the
// plan's meals + ingredients to Sonnet via tool_use; the model returns
// the 4-phase Prep the Week structure with cross-meal aggregation. Premium
// per PRD §1.2 + §13.4.6 (content-generating AI). Phase order is fixed —
// proteins LAST for food safety per PRD §13.4.1.
//
// D-WS9-301 rule 9 (Hans, October 1 device pass) — THE PHASES ARE THE KIND OF
// WORK, IN THE ORDER A COOK WORKS A BOARD: dry, then produce, then the sauces
// and marinades those cuts feed, then proteins. `produce` and
// `sauces_marinades` swapped places; the KEYS are unchanged, so no stored
// stepKey moves. His own strategy is the spec: "measure the dry stuff so I can
// re-use the measuring cups and spoons… then I do my produce… then I would add
// the olive oil and lemon juice to any marinades I can make ahead. and then, if
// I am still going strong, I will trim the chicken for the week."

import { z } from "zod";

// Canonical 4-phase enum, slugified PRD §13.4.1 names. The result schema
// pins length=4 AND order via PrepWeekResultSchema; the prompt is
// independently instructed to emit them in this same order — both checks
// must agree before the response is returned.
export const PrepWeekPhaseKey = z.enum([
  "seasonings_dry",
  "produce",
  "sauces_marinades",
  "proteins",
]);
export type PrepWeekPhaseKeyT = z.infer<typeof PrepWeekPhaseKey>;

// ── input ────────────────────────────────────────────────────────────

export const PrepWeekIngredientInputSchema = z.object({
  ingredientId: z.string().uuid(),
  ingredientName: z.string().min(1),
  quantity: z.number(),
  unit: z.string(),
  // e.g. "diced", "minced", "thinly sliced". Drives whether the AI
  // batches same-ingredient prep into a single step or splits by method.
  preparationNotes: z.string().optional(),
});

export const PrepWeekDishInputSchema = z.object({
  dishId: z.string().uuid(),
  dishName: z.string().min(1),
  ingredients: z.array(PrepWeekIngredientInputSchema),
});

export const PrepWeekMealInputSchema = z.object({
  mealId: z.string().uuid(),
  mealName: z.string().min(1),
  cuisine: z.string().optional(),
  // effectiveServings after override applied at the loader boundary.
  servings: z.number().int().min(1).max(20),
  dishes: z.array(PrepWeekDishInputSchema).min(1).max(8),
});

export const PrepWeekInputSchema = z.object({
  planId: z.string().uuid(),
  planName: z.string().min(1),
  // 14 = 7 days × 2 meals worst-case for the Prep the Week aggregation.
  meals: z.array(PrepWeekMealInputSchema).min(1).max(14),
});
export type PrepWeekInput = z.infer<typeof PrepWeekInputSchema>;

// ── result ───────────────────────────────────────────────────────────

export const PrepWeekStepSchema = z.object({
  number: z.number().int().min(1).max(50),
  // WS7-8a B3 (D-WS7-153) — STABLE per-step identity for checkbox persistence.
  // Code-owned, derived from (phase, ingredientId): `${phase}#${ingredientId}`
  // for a normal step, `${phase}#dish#${dishId}` for a per-dish grouped step —
  // both seasonings_dry blends (BUG-016 / D-WS7-187) and sauces_marinades dishes.
  // Survives a structureJson regenerate (same ingredient → same key regardless
  // of array position), unlike `number`. Persisted on the wire so mobile and
  // the PrepStepCompletion rollup share one identity. Longest value is
  // `sauces_marinades#<uuid>` ≈ 53 chars; 80 is a safe ceiling.
  stepKey: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(800),
  estimatedMinutes: z.number().int().min(1).max(60),
  // Destination labels per PRD §13.4.3 — every step states which meals
  // it contributes to so the UI can render "For Tuesday's tacos and
  // Friday's burrito bowls". Must reference real mealIds from the input;
  // route-level sanity check enforces this in Phase 2.
  contributesToMealIds: z.array(z.string().uuid()).min(1).max(20),
  // Optional. Use only when storage is non-trivial (e.g. airtight
  // container, 4 days max). Skip for self-evident cases.
  storageNote: z.string().max(200).optional(),
  // WS7-8a B2b (D-WS7-150) — narration-suggested skip. Set true when the
  // step's ingredients appear ONLY in a season-and-cook step (judged by the
  // AI from step prose), so the user does it while cooking, not at prep time.
  // Pure annotation: code-owned number / contributesToMealIds / quantities
  // are untouched. Mobile renders skipSuggested steps muted (Block 8b).
  skipSuggested: z.boolean().optional(),
  /**
   * D-WS9-301 rule 7 — CODE-OWNED. True for a step that holds no food: the
   * cook-day protein instruction ("On cook day: 1½ lb skirt steak into the
   * Carne Asada marinade bowl"). It is a sentence about Friday, not a container,
   * and counting it would inflate the header's first number.
   */
  holdsNoContainer: z.boolean().optional(),
  /**
   * H4 / D-WS9-301 rule 11(c) — CODE-OWNED. The container this step works on,
   * when it has one. A container is now worked in up to two steps — its dry
   * measure in phase 1 and its wet finish in phase 3 — and it is ONE container.
   * The header counts DISTINCT values of this field, so the redistribution
   * cannot inflate the tally by re-sorting the same work into more steps.
   *
   * Opaque to the client: an id, never shown. Absent on a step that is its own
   * container (a per-ingredient portion), and absent from any structureJson
   * cached before this shipped — where the count falls back to per-step, which
   * is what that blob was counted as when it was written.
   */
  containerId: z.string().min(1).max(120).optional(),
  /**
   * H4 / D-WS9-301 rule 11(c) — CODE-OWNED. True for a step that holds no food
   * OF ITS OWN because every portion it produces has a named destination: the
   * knife work that fills other containers. "Mince all the garlic — 2 cloves to
   * the marinade bowl, 1 to the chili container" puts no third bowl on the
   * counter.
   *
   * 🔴 NOT the same as holdsNoContainer, and deliberately a separate field. A
   * cook-day sentence is not work the cook does at prep time; this IS, so it
   * still counts toward the minutes AND stays in the completion set
   * (prepStepSet.ts). Only the container tally skips it.
   */
  /**
   * H6.1-B — the vessels this step fills, by name: its own container plus every
   * container its portions go into. The header's first number is the union of
   * these across the rendered steps.
   *
   * 🔴 REPLACES `feedsContainersOnly`. That boolean asked whether a step put a
   * bowl out of its own, which stopped distinguishing anything once rule 11 gave
   * every portion a destination — it became true of every ingredient step and the
   * count collapsed to the mixtures. A container counts once however many steps
   * touch it, and a step that fills three has to be able to say so.
   */
  containerNames: z.array(z.string().min(1).max(120)).max(12).optional(),
  /**
   * H6.1-C — CODE-OWNED. This step is not the last to touch its container, so it
   * carries no storage line: the bowl is opened again in a later phase and the
   * line belongs to the step that closes it. A fridge sentence on a bowl the cook
   * is about to add to is the contradiction Hans read on the device.
   */
  suppressStorage: z.boolean().optional(),
  /**
   * Part J.0 (D-WS7-153 carry b) — CODE-OWNED. The cook steps whose knife or
   * mixing work THIS prep step did, by the cook step's own identity. Derived from
   * the cook steps' `amountRefs`: a `prep`-phase cook step is listed when every
   * ingredient it states an amount for is handled by a prep step that renders.
   *
   * The client's prepped path reads it: a cook step shows as "done in prep" only
   * when every prep step listing it is complete. Absent on a step that covers none
   * (and on any blob cached before this shipped). The cooking-sequence route stays
   * plan-agnostic; the plan payload carries the join.
   */
  coversCookSteps: z
    .array(
      z.object({
        mealId: z.string().uuid(),
        dishId: z.string().uuid(),
        stepIndex: z.number().int().min(0),
      }),
    )
    .max(60)
    .optional(),
});
export type PrepWeekStep = z.infer<typeof PrepWeekStepSchema>;

export const PrepWeekPhaseSchema = z.object({
  phase: PrepWeekPhaseKey,
  title: z.string().min(1).max(80),
  // Phases 1 and 3 (dry, sauces/marinades) skippable; produce and proteins
  // always present. A phase with zero steps is still emitted to keep the
  // 4-phase shape stable across plans.
  skippable: z.boolean(),
  /**
   * WS9 D-WS9-298 item 3 — a quiet line under the phase title, CODE-OWNED and
   * computed on every read. Today only the Proteins phase carries one, saying
   * why that phase is short. Not an alert and not a modal: the same tier as a
   * storage note.
   */
  note: z.string().max(200).optional(),
  /**
   * D-WS9-301 rule 13 — the quiet "Held for cook day" list that closes the
   * Proteins phase: the steps D-WS9-298 demotes, SHOWN rather than silently
   * dropped. "Texas-style chili (Saturday, 5 days out) — cube the chuck that
   * morning."
   *
   * ⚠️ CODE-OWNED and computed on every read, like the storage notes and for
   * the same reason: which steps are held depends on today's cook days.
   */
  heldForCookDay: z.array(z.string().max(200)).max(20).optional(),
  steps: z.array(PrepWeekStepSchema).min(0).max(30),
});
export type PrepWeekPhase = z.infer<typeof PrepWeekPhaseSchema>;

// Phase order is fixed: seasonings_dry → produce → sauces_marinades →
// proteins (D-WS9-301 rule 9). Enforced by the .superRefine below. The model is
// also told this in the prompt; the schema is the structural floor.
export const PrepWeekResultSchema = z
  .object({
    totalEstimatedMinutes: z.number().int().min(1).max(240),
    /**
     * D-WS9-301 rule 7 / ruling 4 — the header's two numbers. Both are CODE's,
     * computed over the steps that actually render, and both are recomputed on
     * every read for the same reason the storage notes are: a protein demoted by
     * today's cook day changes the count.
     *
     * Optional so a `structureJson` blob written before this shipped still
     * parses; the route fills them on the way out either way.
     */
    containerCount: z.number().int().min(0).optional(),
    /** Sum of the rendered steps' minutes, ROUNDED UP to the next 5 (ruling 4). */
    estimatedMinutes: z.number().int().min(0).optional(),
    phases: z.array(PrepWeekPhaseSchema).length(4),
  })
  .superRefine((val, ctx) => {
    const expected: PrepWeekPhaseKeyT[] = [
      "seasonings_dry",
      "produce",
      "sauces_marinades",
      "proteins",
    ];
    for (let i = 0; i < 4; i++) {
      if (val.phases[i].phase !== expected[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", i, "phase"],
          message: `phase at index ${i} must be "${expected[i]}", got "${val.phases[i].phase}"`,
        });
      }
    }
  });
export type PrepWeekResult = z.infer<typeof PrepWeekResultSchema>;
