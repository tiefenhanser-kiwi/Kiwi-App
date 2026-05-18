import { z } from "zod";
import { StepPhaseSchema } from "./cookNow";

// PRD §13.5.4 / 6d-1 — Cooking Sequencer.
// Free per PRD §13.5.5 (infrastructure AI; reorders + annotates existing
// steps — does NOT rewrite step text or generate new content). Single-dish
// meals skip the AI and return stored step order directly at the loader.

// Per-dish step as fed to the sequencer. Mirrors the persisted
// RecipeInstructionStep row minus columns the sequencer doesn't need.
export const SequencerDishStepSchema = z.object({
  dishId: z.string().min(1),
  stepIndex: z.number().int().min(0),
  stepText: z.string().min(1),
  phaseType: StepPhaseSchema,
  parallelGroup: z.string().nullable(),
  // Coerced to >= 1 at the loader boundary (15-second floor).
  estimatedMinutes: z.number().int().positive(),
  // Signals two things at once to the sequencer: (1) the user is actively
  // engaged in this step — do not weave another dish's step between it and
  // the next step of the same dish; (2) if the step also needs lead time
  // (e.g. preheat), schedule it early enough that the next step in the
  // same dish flows immediately when the user gets there.
  isTimingSensitive: z.boolean(),
});
export type SequencerDishStep = z.infer<typeof SequencerDishStepSchema>;

export const SequencerInputSchema = z.object({
  mealDishes: z.array(
    z.object({
      dishId: z.string().min(1),
      title: z.string().min(1),
      positionIndex: z.number().int().nonnegative(),
    }),
  ),
  dishSteps: z.array(SequencerDishStepSchema),
});
export type SequencerInput = z.infer<typeof SequencerInputSchema>;

// Single step in the AI's intermixed sequence. Output references the
// original step by (dishId, originalStepIndex); step text is preserved
// verbatim downstream — the sequencer does NOT rewrite content.
export const SequencedStepSchema = z.object({
  dishId: z.string().min(1),
  originalStepIndex: z.number().int().min(0),
  sequenceIndex: z.number().int().min(0),
  startsAtMinutes: z.number().int().nonnegative(),
  // Short inline rationale shown in Cook Mode; e.g.
  // "While the chicken rests, start the sauce." Optional per step.
  reason: z.string().max(140).optional(),
  // Hard dependencies the sequence ordering enforces. Most steps don't
  // have one — populate only when there's a true must-finish-first link.
  dependsOn: z
    .array(
      z.object({
        dishId: z.string().min(1),
        originalStepIndex: z.number().int().min(0),
      }),
    )
    .optional(),
});
export type SequencedStep = z.infer<typeof SequencedStepSchema>;

export const SequencedStepsResultSchema = z.object({
  steps: z.array(SequencedStepSchema),
  totalEstimatedMinutes: z.number().int().positive(),
});
export type SequencedStepsResult = z.infer<typeof SequencedStepsResultSchema>;
