import { z } from "zod";
import { StepPhaseSchema } from "./cookNow";

// PRD §13.5.4 / 6d-1 — Cooking Sequencer.
// Free per PRD §13.5.5 (infrastructure AI; no new content generation).
// Degrades to simple step ordering for single-dish meals.

// Compact step shape the sequencer reasons about.
export const SequencerStepSchema = z.object({
  dishId: z.string().min(1),
  stepIndex: z.number().int().min(0),
  text: z.string().min(1),
  estimatedMinutes: z.number().int().positive(),
  phaseType: StepPhaseSchema,
  parallelGroup: z.string().optional(),
  isTimingSensitive: z.boolean().default(false),
  // Steps that must complete before this one (cross-dish or intra-dish).
  dependsOn: z
    .array(
      z.object({
        dishId: z.string().min(1),
        stepIndex: z.number().int().min(0),
      }),
    )
    .optional(),
});
export type SequencerStep = z.infer<typeof SequencerStepSchema>;

export const SequencerInputSchema = z.object({
  mealId: z.string().min(1),
  // Per-dish step lists. Sequencer intermixes them into one sequence.
  mealDishes: z.array(
    z.object({
      dishId: z.string().min(1),
      title: z.string().min(1),
      // Target time the dish needs to be ready (relative offset from t=0).
      readyAtOffsetMinutes: z.number().int().nonnegative().optional(),
    }),
  ),
  dishSteps: z.array(SequencerStepSchema),
});
export type SequencerInput = z.infer<typeof SequencerInputSchema>;

// PRD §13.5.4 — single ordered sequence intermixing all dishes.
export const SequencedStepSchema = z.object({
  // Pointer back to the source step (so the UI can render dish color/badge).
  dishId: z.string().min(1),
  stepIndex: z.number().int().min(0),
  // 0-based position in the sequence.
  sequenceIndex: z.number().int().min(0),
  // Offset from t=0 the user should start this step.
  startsAtMinutes: z.number().int().nonnegative(),
  // Optional rationale ("Start now so it finishes when pasta is ready").
  reason: z.string().max(140).optional(),
});
export type SequencedStep = z.infer<typeof SequencedStepSchema>;

export const SequencedStepsResultSchema = z.object({
  totalEstimatedMinutes: z.number().int().positive(),
  steps: z.array(SequencedStepSchema),
});
export type SequencedStepsResult = z.infer<typeof SequencedStepsResultSchema>;
