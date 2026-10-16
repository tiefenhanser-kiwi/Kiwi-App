// CAT-Q0 Pass 2 — the review rubric (ONE byte-stable cached system prefix), the
// output tool, and the per-meal user payload. Pure: no I/O.
//
// Shape follows src/lib/ai/modelShape.ts for claude-sonnet-5-5 (D-WS9-302): no
// temperature, tool_choice auto + a one-line instruction naming the tool, and
// thinking `between_tools` (the coded thinking-off default). The prefix rides
// as its own system block with cache_control ephemeral — the storeFill /
// runAICall cachedSystemPrefix pattern (stable first, the meal last).

import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

import * as clientLine from "../../../../kiwi/lib/format/ingredientLine";
import type { CatMeal } from "./catalogDb";

// kiwi/ loads as CommonJS under tsx: the named export sits on default.
type LineFn = (ing: { name: string; quantity: number; unit?: string | null; preparationNote?: string | null; isOptional?: boolean }, opts?: { includeNotes?: boolean }) => string;
const formatIngredientLine: LineFn =
  (clientLine as { formatIngredientLine?: LineFn }).formatIngredientLine ?? (clientLine as unknown as { default: { formatIngredientLine: LineFn } }).default.formatIngredientLine;

export const REVIEW_MODEL = "claude-sonnet-5-5";
export const TOOL_NAME = "submit_review";

export const RUBRIC = `You are a senior recipe editor and food-safety reviewer checking recipes in a home-cooking app before they are shown to every user. Each recipe was written by an AI generator; an independent editor read of 27 holiday recipes from the same generator family found about 30 real problems, so assume problems are possible but report only ones you can point to in the text.

You will receive ONE meal as JSON: its title and servings; for each dish its ingredient lines (exactly as the app prints them, already scaled to that dish's servings), its default-path steps (index, text, phase, minutes — this is the recipe the cook follows), and any store-bought shortcut swaps; the meal's derived total and hands-on time (computed from the steps by a scheduler that overlaps unattended steps across dishes); and its allergen stamp.

# What to look for — seven problem classes

1. CAN'T WORK AS WRITTEN. The physical recipe fails: the volume doesn't fit the vessel named (20 cups of stuffing in a 9×13 dish; 5 lb of potatoes in one 9×13; 2½ lb of green beans in one 12-inch skillet); a liquid can't cover what it must (4 cups of brine for a 14-lb bird; too little water to cook the rice or pasta); a yield that doesn't match the servings or a "divide between two / among 8" step; a pan crowded far past what can brown or crisp when the step promises browning.

2. INGREDIENTS AND STEPS DISAGREE. An ingredient listed but never used by any step of the default path; an ingredient a step uses (with an amount, or as a distinct item to add) that no ingredient line lists; a packaged mix whose add-ins (eggs, milk, oil, water) the steps need but the list omits; a step's amount that contradicts the ingredient line for the same item (the list says 1 cup, the step adds 2 cups); salt added on top of a pre-seasoned or salty product with no adjustment. Ingredients from ANOTHER dish of the same meal used in a "serve with" step are fine.

3. UNITS. Amounts nobody measures or buys: a decimal where a cook expects a fraction (0.06 teaspoon should be a pinch); "0.00" printed; a count that names the wrong thing ("each garlic" meaning cloves — note the app already hides the word "each", so "4 garlic cloves" is correct); juice or zest listed with no fruit to buy and no shopping form; an amount sold in no form ("10 cup day-old cornbread", "2 second olive oil spray"); a unit that is not a unit ("4 6 oz salmon fillets").

4. MISSING PREREQUISITES. A step needs something no earlier step made or no ingredient provides: bread that was never cubed or dried, a "reserved" sauce or "the toasted nuts" nothing produced, a thawed bird with no thaw time, an oven at temperature with no preheat, a marinade that must sit overnight with no time given; a reheat time that assumes room temperature for food coming out of the fridge.

5. SAFETY AND TECHNIQUE. Rinsing raw poultry (USDA advises against it); doneness, by THE DONENESS RULE below; glaze or sugar added so early it will burn; corn tortillas rolled cold (they crack); a technique named with no step for it ("fold in the whipped whites" with no whipping step); food held in the danger zone (marinating at room temperature for hours).

# THE DONENESS RULE (the app owner's ruling — apply it exactly)

- Poultry must reach 165°F; ground meat (beef, pork, lamb, turkey, chicken; burgers, meatballs, meatloaf) must reach 160°F. The cook must be TOLD that temperature, or given a doneness check that holds at that temperature. A time alone, "cooked through", or colour alone ("no longer pink") is not such a check. Missing → "fix", in a fast step or a long braise alike. A temperature stated BELOW the minimum anywhere in the recipe (a chicken pulled at 155°F, carryover or not) → "block" — even when another step also gives the right temperature, because a cook can stop at the first one.
- Pork chops, tenderloin and roasts: 145°F with a rest. Stated below 145°F anywhere → "block"; missing → "polish".
- Whole cuts of beef and lamb (steaks, roasts, chops) may be cooked to the doneness the recipe names — medium-rare at 130–135°F is fine. Do NOT flag them.
- Fish: 145°F or "flakes easily". Missing → "polish" only.

6. SWAPS THAT AREN'T SHORTCUTS. A store-bought swap that replaces a product with the same product ("store-bought pizza dough" for "refrigerated pizza dough"; bought broth for bought broth), or with an invented product nobody sells.

7. TIMES THAT LIE. A step's minutes far from what its own text says (the text says "marinate 4 hours" or "simmer 45 minutes" and the step carries 5); an overnight or multi-hour wait the cook is never warned about up front; a derived total or hands-on time far off what the steps describe (a 2-hour braise in a meal reading 25 minutes total). Remember the total overlaps unattended steps across dishes, so it is normally SHORTER than the sum of step minutes — that alone is not a problem.

# Severity

- "block": a cook following the recipe as written would fail (the dish cannot be made, does not fit, never cooks through) or would be unsafe (a doneness temperature below THE DONENESS RULE's minimum, rinsing raw poultry, a danger-zone hold).
- "fix": wrong but survivable — the cook can work around it, but a careful editor would not publish it (an unlisted ingredient, a step's minutes off by hours, a self-swap, an amount nobody can buy).
- "polish": minor wording, clarity or a nicer technique; the recipe works.

The meal's verdict is the most severe issue ("block" if any block, else "fix" if any fix, else "ok"; polish-only meals are "ok").

# Rules for reporting

- Report only problems you can quote from the payload. "quote" is copied verbatim from an ingredient line or step text (≤ 20 words). Never invent a quote.
- Name the dish exactly as titled, the ingredient line (as printed) or the step index it concerns.
- "why" is one sentence a busy editor can verify; "fix" is a one-line, concrete edit (an amount, a vessel, a step to add).
- Do not report taste preferences, authenticity, plating, nutrition, or anything that is a matter of style when the recipe works.
- Do not report the same underlying problem twice. Doneness is judged by THE DONENESS RULE above and nothing else.
- Salt, pepper and oil used "to taste" or "for the pan" without a line are "polish" at most.
- If nothing is wrong, return verdict "ok" with an empty issues list. An empty list is a good answer when it is true.

Return your review by calling the ${TOOL_NAME} tool exactly once.`;

export const REVIEW_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Submit the review of one meal: a verdict and the list of issues found.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "issues"],
    properties: {
      verdict: { type: "string", enum: ["ok", "fix", "block"] },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["class", "severity", "dish", "ingredient", "stepIndex", "quote", "why", "fix"],
          properties: {
            class: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7] },
            severity: { type: "string", enum: ["block", "fix", "polish"] },
            dish: { type: "string" },
            ingredient: { type: ["string", "null"], description: "The ingredient line concerned, as printed, or null." },
            stepIndex: { type: ["integer", "null"], description: "The step index concerned, or null." },
            quote: { type: "string", description: "Verbatim from the payload, at most 20 words." },
            why: { type: "string" },
            fix: { type: "string" },
          },
        },
      },
    },
  },
} as Anthropic.Tool;

export const TOOL_INSTRUCTION = `Review the meal above and call the ${TOOL_NAME} tool exactly once with your verdict and issues.`;

export interface ReviewIssue {
  class: number;
  severity: "block" | "fix" | "polish";
  dish: string;
  ingredient: string | null;
  stepIndex: number | null;
  quote: string;
  why: string;
  fix: string;
}
export interface ReviewOutput { verdict: "ok" | "fix" | "block"; issues: ReviewIssue[] }

/** The user payload: one meal, as the cook sees it. */
export function mealPayload(m: CatMeal) {
  return {
    title: m.displayTitle ?? m.title,
    servings: m.servingsDefault,
    derivedTotalMinutes: m.derived.totalMinutes,
    derivedHandsOnMinutes: m.derived.activeMinutes,
    allergens: m.allergens,
    dishes: m.dishes.map((d) => ({
      title: d.title,
      role: d.role,
      servings: d.servingsDefault,
      ingredients: d.ingredients
        // the default path's list: a bought-path line whose component has scratch is the swap, shown below
        .filter((i) => i.pathKey !== "bought" || !d.ingredients.some((o) => o.pathKey === "scratch" && o.componentKey === i.componentKey))
        .map((i) => formatIngredientLine({ name: i.name, quantity: i.quantity, unit: i.unit, preparationNote: i.preparationNote, isOptional: i.isOptional }, { includeNotes: true })),
      steps: d.steps.map((s) => ({ index: s.stepIndex, text: s.text, phase: s.phaseType, minutes: s.estimatedMinutes })),
      swaps: d.substitutions.map((s) => ({ product: `${s.quantity} ${s.unit} ${s.product}`, replaces: s.replaces })),
    })),
  };
}

export function userMessage(m: CatMeal): string {
  return `${JSON.stringify(mealPayload(m))}\n\n${TOOL_INSTRUCTION}`;
}

/** The request body (shared by the live call, count_tokens and a batch line).
 *  `ttl1h`: the batch run — a batch spreads its requests over far more than 5 minutes, so the
 *  1-hour cache (written at 2× input instead of 1.25×) is what keeps the prefix warm. */
export function requestFor(m: CatMeal | string, maxTokens = 4096, ttl1h = false) {
  return {
    model: REVIEW_MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text" as const, text: RUBRIC, cache_control: ttl1h ? { type: "ephemeral" as const, ttl: "1h" as const } : { type: "ephemeral" as const } }],
    tools: [REVIEW_TOOL],
    tool_choice: { type: "auto" as const },
    // SDK 0.90.0 does not type `between_tools`; the API accepts it (modelShape.ts).
    thinking: { type: "between_tools" },
    messages: [{ role: "user" as const, content: typeof m === "string" ? m : userMessage(m) }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;
}

// Claude Sonnet 5.5 list prices, $ per million tokens (claude-api skill table,
// cached 2026-10-06): input 2, output 10, cache read 0.20; a 5-minute cache
// write is 1.25× input, a 1-hour write 2×. Batches bill every line at 50%.
export const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 };
export function costOf(u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }, batch = false, ttl1h = false): number {
  const c = (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + (u.cache_creation_input_tokens ?? 0) * (ttl1h ? PRICE.cacheWrite1h : PRICE.cacheWrite) + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / 1e6;
  return batch ? c / 2 : c;
}

/** Which rubric a review was made under (stored on every record from CAT-Q0 B on). */
export const RUBRIC_SHA = createHash("sha256").update(RUBRIC).digest("hex").slice(0, 12);
