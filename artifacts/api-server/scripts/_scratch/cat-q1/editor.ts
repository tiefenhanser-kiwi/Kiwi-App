// CAT-Q1 Part C — the AI editor: its byte-stable cached instruction prefix, the
// patch tool, and the per-meal payload. Pure: no I/O.
//
// The payload is CAT-Q0's review payload (rubric.mealPayload — the default
// path, the lines as the screen prints them) with each line and step given a
// short id (i1…, s1…) and its STORED fields beside the printed line, so an
// edit's `old` can be copied exactly. The ids map back to row ids in code.
//
// Request shape = rubric.requestFor's (D-WS9-302 for claude-sonnet-5-5: no
// temperature, tool_choice auto + a one-line instruction, thinking
// between_tools), with its own cached system prefix.
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

import type { CatMeal } from "../cat-q0/catalogDb";
import { mealPayload, REVIEW_MODEL } from "../cat-q0/rubric";
import type { Q0Issue } from "./issues";

export const EDITOR_MODEL = REVIEW_MODEL;
export const EDIT_TOOL = "submit_patch";

export const EDITOR_PROMPT = `You are the editor who fixes recipes in a home-cooking app after a reviewer has flagged problems. The recipes are shown to every new user. You make the SMALLEST set of edits that fixes the issues you are given, and you change nothing else.

You receive ONE meal as JSON: for each dish its ingredient lines (each with an id like "i3", the line as the screen prints it, and the STORED fields: quantity, unit, name, note, optional) and its steps (each with an id like "s7", its index, text, phase and minutes), plus a numbered list of issues from the reviewer (severity, class, dish, where, quote, why, suggested fix).

# What you may do

- Edit a step: replace its text and/or its minutes. Keep the author's voice and everything in the step that the issue does not concern; usually you change one phrase or add one sentence.
- Edit an ingredient line: its quantity, unit, name, note or optional flag. Or remove a line ("remove": true) when an issue says it is never used and no step should use it.
- Add a new ingredient line to a dish, ONLY when a step uses an item no line lists (e.g. a step juices a lemon and no lemon is listed: add "1 lemon"). Use a plain grocery name ("lemon", "unsalted butter", "chicken broth"); it must match an existing catalog ingredient or the whole patch is rejected.

# What you must never do (code enforces every one; a patch that breaks one is rejected whole)

- Never touch a step or line that no issue names, except what your change strictly requires: the line whose amount a step now states; the new line an edited step now uses; or a step that uses the SAME pan, sheet, pot or water bath, or the SAME ingredient, as a step an issue names (the preheat that must now heat two pans, the "repeat with the remaining half", the other dish's step that shared the pan). A step that shares neither stays as it is: put whatever else the fix needs into the step the issue names.
- Never change a title, the servings, the set of dishes, a step's phase, or add, remove or reorder steps. If a fix needs a new step, fold it into the nearest existing step as a sentence.
- "old" must be copied EXACTLY from the payload's stored fields (text character for character, numbers as given).
- Quantities are plain JSON numbers: 0.5, 0.25, 1.5, 0.3333 for a third — NEVER a fraction glyph or a string. Fraction glyphs (½ ¼ ¾ ⅓ ⅔ ⅛) belong ONLY in step text, where amounts must also be cook's fractions (never "0.5 cup" in text; write "½ cup").
- Amounts are cook's fractions (a whole number plus ⅛ ¼ ⅓ ½ ⅔ ¾); never ⅜ ⅝ ⅞ of a spoon or cup. Units: teaspoon, tablespoon, cup, ounce, pound, each, clove, sprig, slice, head, stalk, can, bunch, inch, fluid ounce, quart, leaf, pinch, pint, gram, packet, strip, jar, sheet, loaf.
- Never add a step amount that disagrees with its ingredient line.

# How to fix the common classes

- Doneness (the app owner's rule): poultry 165°F, ground meat 160°F, stated to the cook as an internal temperature. For a piece: "until an instant-read thermometer in the thickest part reads 165°F". For crumbled ground meat: keep the colour cue and add "and an instant-read thermometer reads 160°F". For patties, meatballs and meatloaf: "in the center". A temperature stated BELOW the minimum anywhere must be changed or removed — a cook stops at the first number. Pork chops, tenderloin and roasts: 145°F, then rest 3 minutes. Whole cuts of beef and lamb: leave the named doneness alone. Fish: leave alone.
- SOUS VIDE: when an issue says the ruling covers it, do exactly what its fix says. If it gives a new time, change the bath step's time in the text to exactly that time and set that step's minutes to it. Then add ONE sentence to the bath step saying that holding at the stated temperature for the full time is what makes it safe to eat — use the words "holding" and "what makes it safe". Change nothing else in that dish's doneness.
- Juice or zest with no fruit to buy: add ONE whole-fruit line ("1 lemon") whose note says only what the meal does with it ("juiced"; "zested"; "zest, then juice" only when the meal uses both) and, in the same patch, REMOVE every zest and juice line of that fruit in the meal (any dish), answering the same issue. Keep their amounts in the step text. The shopping list buys the fruit for them; keeping both lines buys it twice.
- Times that lie: set the step's minutes to what its own text says (the low end of a range). Never edit minutes for any other reason.
- Rinsing poultry: delete the rinse, keep "pat dry".
- Ingredients and steps disagree: make the step match the line, or the line match the step, whichever the issue's fix says.
- Can't work as written / missing prerequisites: the smallest concrete change (two baking sheets instead of one; a preheat sentence at the start of the first step that needs the oven).

# Declining

If an issue is wrong, or cannot be fixed without breaking a rule above (it needs a new dish, a new step, a title or servings change), DECLINE it with a one-line reason. Declining is a good answer when it is true. Every issue number must appear exactly once: in an edit's "answers" or in "declined".

Return the patch by calling the ${EDIT_TOOL} tool exactly once.`;

const ING = {
  type: "object", additionalProperties: false,
  required: ["quantity", "unit", "name", "note", "optional"],
  properties: {
    quantity: { type: "number", description: "A plain number (0.5, not ½)." },
    unit: { type: "string" },
    name: { type: "string" },
    note: { type: ["string", "null"] },
    optional: { type: "boolean" },
  },
} as const;
const ANSWERS = { type: "array", items: { type: "integer" }, description: "The issue numbers this edit answers (at least one)." } as const;

export const EDIT_TOOL_DEF: Anthropic.Tool = {
  name: EDIT_TOOL,
  description: "Submit the patch for one meal: the edits and the issues declined.",
  strict: true,
  input_schema: {
    type: "object", additionalProperties: false,
    required: ["step_edits", "line_edits", "new_lines", "declined"],
    properties: {
      step_edits: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["step_id", "old_text", "new_text", "old_minutes", "new_minutes", "answers"],
          properties: {
            step_id: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" },
            old_minutes: { type: "integer" }, new_minutes: { type: "integer" }, answers: ANSWERS,
          },
        },
      },
      line_edits: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["line_id", "old", "new", "remove", "answers"],
          properties: { line_id: { type: "string" }, old: ING, new: ING, remove: { type: "boolean", description: "true deletes the line; `new` is then ignored (copy `old`)." }, answers: ANSWERS },
        },
      },
      new_lines: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["dish", "line", "answers"],
          properties: { dish: { type: "string", description: "The dish title exactly." }, line: ING, answers: ANSWERS },
        },
      },
      declined: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["issue", "reason"], properties: { issue: { type: "integer" }, reason: { type: "string" } } },
      },
    },
  },
} as Anthropic.Tool;

export const EDIT_INSTRUCTION = `Fix the issues above and call the ${EDIT_TOOL} tool exactly once.`;

export interface EditorIng { quantity: number; unit: string; name: string; note: string | null; optional: boolean }
export interface PatchInput {
  step_edits: Array<{ step_id: string; old_text: string; new_text: string; old_minutes: number; new_minutes: number; answers: number[] }>;
  line_edits: Array<{ line_id: string; old: EditorIng; new: EditorIng; remove: boolean; answers: number[] }>;
  new_lines: Array<{ dish: string; line: EditorIng; answers: number[] }>;
  declined: Array<{ issue: number; reason: string }>;
}

/** Short id → row, both ways. */
export interface IdMap {
  line: Map<string, { dishId: string; rowId: string }>;
  step: Map<string, { dishId: string; rowId: string }>;
}

/** The issue as the editor sees it (`n` is what it cites). */
export interface EditorIssue { n: number; severity: string; class: number; dish: string; where: string; quote: string; why: string; fix: string; ruling?: string }

export function editorIssues(issues: readonly Q0Issue[], overrides: Map<number, { severity: string; fix: string; ruling: string }> = new Map()): EditorIssue[] {
  return issues.map((i) => {
    const o = overrides.get(i.n);
    return { n: i.n, severity: o?.severity ?? i.severity, class: i.class, dish: i.dish, where: i.where, quote: i.quote, why: i.why, fix: o?.fix ?? i.fix, ...(o ? { ruling: o.ruling } : {}) };
  });
}

/** `note`: round 2 only — the earlier issues are already fixed in this text. */
export function editorPayload(m: CatMeal, issues: readonly EditorIssue[], note?: string): { json: unknown; ids: IdMap } {
  const p = mealPayload(m);
  const ids: IdMap = { line: new Map(), step: new Map() };
  let li = 0, si = 0;
  const dishes = m.dishes.map((d, k) => {
    const shown = p.dishes[k];
    // mealPayload's own filter: the default path's lines (a bought line whose component has scratch is the swap).
    const lines = d.ingredients.filter((i) => i.pathKey !== "bought" || !d.ingredients.some((o) => o.pathKey === "scratch" && o.componentKey === i.componentKey));
    if (lines.length !== shown.ingredients.length) throw new Error(`editorPayload: line filter drifted from rubric.mealPayload in ${d.title}`);
    return {
      title: shown.title, role: shown.role, servings: shown.servings,
      ingredients: lines.map((i, j) => {
        const id = `i${++li}`;
        ids.line.set(id, { dishId: d.dishId, rowId: i.id! });
        return { id, printed: shown.ingredients[j], stored: { quantity: i.quantity, unit: i.unit, name: i.name, note: i.preparationNote, optional: i.isOptional } };
      }),
      steps: d.steps.map((s) => {
        const id = `s${++si}`;
        ids.step.set(id, { dishId: d.dishId, rowId: s.id! });
        return { id, index: s.stepIndex, text: s.text, phase: s.phaseType, minutes: s.estimatedMinutes };
      }),
      swaps: shown.swaps,
    };
  });
  return {
    json: { meal: { title: p.title, servings: p.servings, derivedTotalMinutes: p.derivedTotalMinutes, derivedHandsOnMinutes: p.derivedHandsOnMinutes, dishes }, issues, ...(note ? { note } : {}) },
    ids,
  };
}

export function editorRequest(userMsg: string, maxTokens = 4096, ttl1h = false) {
  return {
    model: EDITOR_MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text" as const, text: EDITOR_PROMPT, cache_control: ttl1h ? { type: "ephemeral" as const, ttl: "1h" as const } : { type: "ephemeral" as const } }],
    tools: [EDIT_TOOL_DEF],
    tool_choice: { type: "auto" as const },
    thinking: { type: "between_tools" },
    messages: [{ role: "user" as const, content: userMsg }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;
}

export const editorUserMessage = (json: unknown) => `${JSON.stringify(json)}\n\n${EDIT_INSTRUCTION}`;
export const EDITOR_SHA = createHash("sha256").update(EDITOR_PROMPT).update(JSON.stringify(EDIT_TOOL_DEF)).digest("hex").slice(0, 12);
