import { z } from "zod";

// PRD §13.5.4 / §13.5.5 — Cooking Sequencer OUTPUT contract.
//
// BUG-018 B2: ordering is now computed DETERMINISTICALLY (cookingScheduler.ts),
// not by Sonnet. This file is only the response shape. The former AI-INPUT
// schemas — SequencerDishStepSchema (with its D-WS6-093 isTimingSensitive-vs-
// parallelGroup superRefine), SequencerInputSchema, and SequencedStepsResult —
// were deleted with the AI call: the scheduler takes typed DB rows, not a
// validated tool payload, and the loader returns the scheduler's result
// directly (no self-validation of computed output).

// One step in the computed sequence. References the source step by
// (dishId, originalStepIndex); step text is preserved verbatim downstream —
// the Sequencer reorders + annotates, never rewrites.
export const SequencedStepSchema = z.object({
  dishId: z.string().min(1),
  originalStepIndex: z.number().int().min(0),
  sequenceIndex: z.number().int().min(0),
  // Serve-anchored offset (ruling #2): 0 = serve (the latest finish), negative
  // = minutes before serve. NEVER wall-clock, never a timezone — a future
  // consumer supplies the real serve time T, so DST/TZ bugs cannot reach here.
  // Re-anchored from the old cook-start `startsAtMinutes` in BUG-018 B2 (nothing
  // consumed the old field; keeping both would be a second source of truth).
  startOffsetMinutes: z.number().int().nonpositive(),
  // Short inline rationale shown in Cook Mode; e.g. "While the chicken rests,
  // start the sauce." Optional per step — most steps have none.
  reason: z.string().max(140).optional(),
});
export type SequencedStep = z.infer<typeof SequencedStepSchema>;
