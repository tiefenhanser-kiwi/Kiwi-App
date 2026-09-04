import { z } from "zod";
import { WizardPlanCandidatesResultSchema } from "./wizard";

// PRD §6.8 — Tell Kiwi (directed input) request shape.
// Mirrors TellKiwiInput in artifacts/kiwi/lib/types.ts:503.
export const DirectedInputSchema = z.object({
  description: z.string().min(5).max(500),
  householdSize: z.number().int().min(1).max(30),
  // Cookbook Phase B Block 4 (D-WS7-190) — wantsLeftovers Switch removed from
  // Tell Kiwi; optional-with-default so an omitting body still validates.
  wantsLeftovers: z.boolean().optional().default(false),
  // Cookbook Phase B Block 4 (Ruling 3) — Tell Kiwi's "Adjust saved prefs for
  // this plan" disclosure now carries cuisines + weeklyPacing per-run. The
  // wizard.directed.generate body already has a "# Cuisine guidance" section
  // that leans on the user's preferred cuisines "if given" and a discovery
  // clause gated on "the user gave a cuisine steer" — supplying `cuisines`
  // here ACTIVATES that guidance for the directed path (previously it always
  // fell to the no-steer varied-palette default). weeklyPacing is referenced
  // only loosely in the directed body, so it is available but weakly weighted.
  cuisines: z.array(z.string()).default([]),
  weeklyPacing: z
    .enum(["mostly_easy", "mixed", "one_fancy_night", "minimal_effort"])
    .optional(),
  eatingStyles: z.array(z.string()).default([]),
  // BUG-201 / D-WS9-214 — OPTIONAL WITH NO DEFAULT. Same fix and same reason as
  // WizardInputSchema (ai/schemas/wizard.ts): `.default([])` collapsed "the Tell
  // Kiwi screen never loaded stored prefs" into "the user has no allergies", and
  // the route then ran the shelf query with no allergen filter at all.
  // resolveAllergenPreference must be able to see the absence.
  allergiesAndAvoidances: z.array(z.string()).optional(),
  dietaryNotes: z.string().max(500).optional(),
  // Cookbook Phase B Block 4 (D-WS7-035) — per-run overrides. Optional, NO
  // default (see WizardInputSchema note): omitted means "use stored". The
  // route resolves these into `preferencesContext`.
  discoveryMealsPerWeek: z.number().int().min(0).max(2).optional(),
  saucePreference: z.enum(["store_bought", "balanced", "homemade"]).optional(),
  maxCookTimeMinutes: z.number().int().positive().max(600).nullable().optional(),
  maxCookTimeCoverage: z.enum(["all", "most"]).optional(),
});
export type DirectedInput = z.infer<typeof DirectedInputSchema>;

// BUG-099 — see the `needsClarification` note below. Collapses the model’s
// several spellings of "nothing to clarify" to `undefined` (key absent) and
// passes everything else through untouched, so the object validator still
// rejects genuinely malformed payloads.
function normalizeNeedsClarification(value: unknown): unknown {
  if (value == null) return undefined;
  // Non-objects (and arrays) are NOT ours to interpret — hand them to the
  // object validator so they reject with a real type error.
  if (typeof value !== "object" || Array.isArray(value)) return value;
  const reason = (value as { reason?: unknown }).reason;
  // A blank reason is as useless to the client as no reason at all: mobile
  // renders `needsClarification?.reason` directly, so an empty string would
  // surface an empty notice. Treat it as absent.
  if (typeof reason !== "string" || reason.trim() === "") return undefined;
  return value;
}

// PRD §6.8 — output of step 1 (parse_intent).
// Five scenarios per PRD §6.5; populated fields differ by scenario.
export const ParsedIntentSchema = z.object({
  scenario: z.enum([
    "vague",
    "fully_specified",
    "partial",
    "unclear",
    "overflow",
  ]),
  // Meals the user named explicitly (e.g. "tacos and pasta").
  explicitMeals: z.array(z.string()).default([]),
  // Soft descriptors the user supplied (e.g. "comfort", "low-carb").
  intentDescriptors: z.array(z.string()).default([]),
  // Number of meals the parser inferred the user wants (1-7).
  mealCount: z.number().int().min(0).max(7).optional(),
  // Populated for `unclear` and `overflow` scenarios per PRD §6.5
  // Scenario E/F. Client surfaces this as a clarification modal.
  //
  // BUG-099 — the model is nondeterministic about how it spells "nothing to
  // clarify". The prompt says to omit the key entirely for vague / partial /
  // fully_specified, and mostly it does — but it also emits a bare `{}`, which
  // `.optional()` does NOT cover: the key is present, so the inner object runs
  // and its required `reason` fails. `.flatten()` then files that under
  // `fieldErrors.needsClarification`, which reads like a missing top-level key
  // and is what made this look like a prompt bug rather than a tolerance one.
  // Observed rate off LLMCallLog: 3 of 24 calls returned 502 this way.
  //
  // So normalise every honest spelling of "nothing to clarify" — omitted, null,
  // `{}`, or any object whose `reason` is missing/blank — to ONE canonical
  // internal form: the key absent (`undefined`). That form is forced, not
  // chosen: the mobile client re-validates with its own Zod requiring `reason`
  // (artifacts/kiwi/lib/api/tellKiwi.ts), so forwarding `{}` would merely move
  // the failure to the device. Every reader already handles absent.
  //
  // Tolerance is deliberately narrow — only the "no usable reason" shapes are
  // dropped. A non-object, an over-long reason, or bad `options` still fails
  // validation exactly as before.
  needsClarification: z.preprocess(
    normalizeNeedsClarification,
    z
      .object({
        reason: z.string().max(280),
        options: z.array(z.string()).max(6).optional(),
      })
      .optional(),
  ),
});
export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

// PRD §6.8 — output of step 2 (generate). Reuses the wizard candidates
// shape; Tell Kiwi may return 1-3 candidates depending on scenario
// (vague/partial → 3; fully_specified → 1; overflow → 1 with
// needsClarification; unclear → empty + needsClarification).
export const DirectedGenerateResultSchema = WizardPlanCandidatesResultSchema;
export type DirectedGenerateResult = z.infer<
  typeof DirectedGenerateResultSchema
>;
