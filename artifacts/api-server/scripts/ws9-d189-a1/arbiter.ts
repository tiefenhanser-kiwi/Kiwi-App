// WS9 D-WS9-189 A1 — the arbiter: a second Opus pass over the residue, where
// the JUDGE resolves what the first pass could not, instead of Hans.
//
// This is the BUG-032 shape. The first pass judges a whole family cold; the
// arbiter re-examines only the pairs that came back medium/low-confidence or
// contradiction-flagged, and it gets something the first pass did not have:
// THE FAMILY'S OWN FIRST-PASS ANSWERS, and the specific reason each disputed
// pair was flagged. A contradiction is only resolvable by something that can
// see both sides of it.
//
// 🔴 §27.4/§27.5 APPLY TO THE ARBITER ITSELF, AND THIS IS THE PART MOST LIKELY
// TO LOOK LIKE IT WORKS WHEN IT DOES NOT. An arbiter that resolves 100% of its
// input is exactly as suspicious as a test that never goes red — the residue
// did not vanish, it was laundered into confident-looking rows nobody checked.
// So STILL_UNSURE is a first-class verdict here, the prompt actively invites
// it, and `--arbiter-fixture` proves the path is reachable by feeding it
// genuinely undecidable pairs and requiring it to decline.

import Anthropic from "@anthropic-ai/sdk";

import type { Confidence, Label, Usage } from "./judge";
import { JUDGE_MODEL, maxTokensFor } from "./judge";

export const ARBITER_PROMPT_VERSION = "d189-a1-arb-v2-subsumes";

export type ArbiterLabel = Label | "STILL_UNSURE";

export interface DisputedPair {
  key: string;
  a: string;
  b: string;
  family: string;
  firstLabel: string;
  firstConfidence: string;
  firstReason: string;
  /** Why it landed in residue: the detector detail, or the confidence band. */
  residueReason: string;
  contradictionDetail: string;
}

/** One line of family context: a first-pass verdict the arbiter can lean on. */
export interface ContextVerdict {
  a: string;
  b: string;
  label: string;
  confidence: string;
}

export interface ArbiterVerdict {
  pairIndex: number;
  label: ArbiterLabel;
  confidence: Confidence;
  reason: string;
  baseIsA?: boolean | null;
  genericIsA?: boolean | null;
  yieldQuantity?: number | null;
  yieldUnit?: string | null;
  coHarvestable?: boolean | null;
}

const ARBITER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pairIndex: { type: "integer" },
          label: {
            type: "string",
            enum: ["SYNONYM", "COMPONENT", "DISTINCT", "SUBSUMES", "STILL_UNSURE"],
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
          baseIsA: { type: ["boolean", "null"] },
          genericIsA: { type: ["boolean", "null"] },
          yieldQuantity: { type: ["number", "null"] },
          yieldUnit: { type: ["string", "null"] },
          coHarvestable: { type: ["boolean", "null"] },
        },
        required: [
          "pairIndex",
          "label",
          "confidence",
          "reason",
          "baseIsA",
          "genericIsA",
          "yieldQuantity",
          "yieldUnit",
          "coHarvestable",
        ],
      },
    },
  },
  required: ["verdicts"],
} as const;

const ARBITER_RUBRIC = `You are the second and final automated pass over a table of ingredient relationships. A first judge already labelled every pair in this food family. The pairs below are the ones it could not settle: it answered at medium or low confidence, or a structural check found its answer inconsistent with its own answers elsewhere.

Your job is to settle them, so that a human only ever sees what genuinely cannot be settled.

The four labels match the first pass:
  SYNONYM   — the same purchase under two names. One product, one trip to the shelf.
  COMPONENT — different ingredients, ONE thing you buy; one is derived from the other
              (lime -> lime juice, garlic head -> garlic clove, pepperoncini -> its brine).
  DISTINCT  — different products sharing a word. A shopper with one must buy the other.
              Grain size, processing state and packaging are all product differences:
              kosher salt is not flaky sea salt, peppercorns are not ground pepper,
              canned diced tomatoes are not canned whole peeled tomatoes.
  SUBSUMES  — one name is GENERIC and the other a SPECIFIC kind of it. A shopper needing
              the generic is satisfied by the specific, but not the reverse.
              bell peppers ~ red bell pepper   (generic = "bell peppers")
              onion ~ yellow onion             (generic = "onion")
              Set genericIsA: true if the FIRST name is the generic, false if the SECOND.
              🔴 TWO SPECIFICS NEVER SUBSUME EACH OTHER — they are DISTINCT. And two names
              qualified on DIFFERENT axes (size vs colour vs cut) do not subsume either way:
              "large bell peppers" ~ "red bell pepper" is DISTINCT.
              🔴 A qualifier that merely names the DEFAULT variety is still SUBSUMES, not
              SYNONYM: "cardamom pods" ~ "green cardamom pods" is SUBSUMES, because black
              cardamom exists and the bare name does not exclude it.
              SUBSUMES carries NO magnitude — leave yieldQuantity/yieldUnit/coHarvestable null.

WHAT YOU HAVE THAT THE FIRST PASS DID NOT. Below the disputed pairs you are given the first pass's answers for the WHOLE family. Use them. Most disputes are resolvable by reading across: if the family already settled "lime ~ lime juice" as COMPONENT at high confidence, then "lemon ~ lemon juice" is COMPONENT, and the dispute is over. Where a contradiction is quoted, the point is that two answers cannot both stand — decide which is right and answer accordingly, even if that means overturning the first pass.

FOR EVERY COMPONENT VERDICT, give the arithmetic: baseIsA (true if the FIRST name is what you buy), yieldQuantity (a number), yieldUnit ("tbsp", "tsp", "cup", "clove", "each", "g", "oz"), and coHarvestable — true when the derivation leaves the base able to yield its other parts (juice and zest both come off one lemon), false when it consumes the unit (a wedge IS the fruit). For SYNONYM and DISTINCT set all four to null.

🔴 STILL_UNSURE IS A REAL ANSWER AND YOU ARE EXPECTED TO USE IT. Some pairs genuinely cannot be settled from two names: the names are too vague to identify a product, the two terms are regionally ambiguous, or the answer depends on a fact about the specific product that neither name carries. Return STILL_UNSURE for those. Do NOT manufacture a confident answer to clear the queue — a wrong confident answer is written to a database and never re-examined, while a STILL_UNSURE costs one human glance. If you cannot tell, say so. Resolving every pair is not the goal; resolving the resolvable ones is.

Return one verdict per disputed pair, using the pairIndex given.`;

export function buildArbiterPrompt(
  family: string,
  disputed: DisputedPair[],
  context: ContextVerdict[],
): string {
  const disputedLines = disputed.map(
    (d, i) =>
      `${i}. "${d.a}"  ~  "${d.b}"\n` +
      `     first pass: ${d.firstLabel} (${d.firstConfidence}) — ${d.firstReason}\n` +
      `     in dispute because: ${d.residueReason}${d.contradictionDetail ? `\n     conflict: ${d.contradictionDetail}` : ""}`,
  );
  const contextLines = context.map(
    (c) => `  "${c.a}" ~ "${c.b}" => ${c.label} (${c.confidence})`,
  );
  return `${ARBITER_RUBRIC}

Food family: ${family}

DISPUTED PAIRS (${disputed.length}) — answer every one:
${disputedLines.join("\n")}

THE FIRST PASS'S ANSWERS FOR THIS WHOLE FAMILY, for reference (${context.length}):
${contextLines.join("\n")}`;
}

function coerce(raw: unknown, count: number): ArbiterVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const idx = typeof o.pairIndex === "number" ? o.pairIndex : Number.NaN;
  if (!Number.isInteger(idx) || idx < 0 || idx >= count) return null;
  const label = String(o.label ?? "").toUpperCase();
  const conf = String(o.confidence ?? "").toLowerCase();
  return {
    pairIndex: idx,
    label:
      label === "SYNONYM" || label === "COMPONENT" || label === "DISTINCT" || label === "SUBSUMES"
        ? (label as ArbiterLabel)
        : "STILL_UNSURE",
    confidence: conf === "high" || conf === "medium" || conf === "low" ? (conf as Confidence) : "low",
    reason: typeof o.reason === "string" ? o.reason : "",
    baseIsA: typeof o.baseIsA === "boolean" ? o.baseIsA : null,
    genericIsA: typeof o.genericIsA === "boolean" ? o.genericIsA : null,
    yieldQuantity: typeof o.yieldQuantity === "number" ? o.yieldQuantity : null,
    yieldUnit: typeof o.yieldUnit === "string" && o.yieldUnit.length > 0 ? o.yieldUnit : null,
    coHarvestable: typeof o.coHarvestable === "boolean" ? o.coHarvestable : null,
  };
}

const RETRIES = 2;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function arbitrateBatch(
  client: Anthropic,
  family: string,
  disputed: DisputedPair[],
  context: ContextVerdict[],
  usage: Usage,
): Promise<ArbiterVerdict[]> {
  const prompt = buildArbiterPrompt(family, disputed, context);
  const maxTokens = maxTokensFor(disputed.length);

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const request = {
        model: JUDGE_MODEL,
        max_tokens: maxTokens,
        output_config: {
          effort: "high" as const,
          format: {
            type: "json_schema" as const,
            schema: ARBITER_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [{ role: "user" as const, content: prompt }],
      };
      const message =
        maxTokens > 16_000
          ? await client.messages.stream(request).finalMessage()
          : await client.messages.create(request);

      usage.calls += 1;
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      if (message.stop_reason === "refusal") throw new Error("arbiter refused");

      const text = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      const parsed = JSON.parse(text) as { verdicts?: unknown[] };
      const byIndex = new Map<number, ArbiterVerdict>();
      for (const raw of parsed.verdicts ?? []) {
        const v = coerce(raw, disputed.length);
        if (v && !byIndex.has(v.pairIndex)) byIndex.set(v.pairIndex, v);
      }
      // A pair the arbiter skipped stays unresolved rather than vanishing.
      return disputed.map(
        (_, i) =>
          byIndex.get(i) ?? {
            pairIndex: i,
            label: "STILL_UNSURE" as const,
            confidence: "low" as const,
            reason: "arbiter returned no verdict for this pair",
            baseIsA: null,
          genericIsA: null,
            genericIsA: null,
            yieldQuantity: null,
            yieldUnit: null,
            coHarvestable: null,
          },
      );
    } catch (err) {
      if (attempt === RETRIES) {
        const reason = `arbiter call failed: ${err instanceof Error ? err.message : String(err)}`;
        return disputed.map((_, i) => ({
          pairIndex: i,
          label: "STILL_UNSURE" as const,
          confidence: "low" as const,
          reason,
          baseIsA: null,
          genericIsA: null,
          yieldQuantity: null,
          yieldUnit: null,
          coHarvestable: null,
        }));
      }
      await sleep(800 * (attempt + 1));
    }
  }
  /* c8 ignore next */
  return [];
}

/**
 * §27.4 for the arbiter — genuinely undecidable pairs.
 *
 * An arbiter nobody has watched decline is not an arbiter, it is a
 * rubber stamp with a JSON schema. Each of these is undecidable for a different
 * reason, so a model that declines all three is declining on the merits rather
 * than pattern-matching one template:
 *
 *   1. REGIONAL AMBIGUITY — "scallion" and "spring onion" name the same plant
 *      in US usage and different growth stages in UK/AU usage. Which one a
 *      recipe means is not in the names.
 *   2. CONTESTED IN THE DOMAIN — queso fresco vs queso blanco are used
 *      interchangeably by some cooks and distinguished by others; there is no
 *      settled answer to find.
 *   3. NO DETERMINABLE CONTENT — two opaque proprietary names. Nothing in
 *      either string identifies a product at all.
 */
export const UNDECIDABLE_FIXTURE: DisputedPair[] = [
  {
    key: "fx1",
    a: "scallions",
    b: "spring onions",
    family: "allium",
    firstLabel: "SYNONYM",
    firstConfidence: "medium",
    firstReason: "commonly used interchangeably",
    residueReason: "confidence_medium",
    contradictionDetail: "",
  },
  {
    key: "fx2",
    a: "queso fresco",
    b: "queso blanco",
    family: "cheese",
    firstLabel: "DISTINCT",
    firstConfidence: "medium",
    firstReason: "different Mexican fresh cheeses",
    residueReason: "confidence_medium",
    contradictionDetail: "",
  },
  {
    key: "fx3",
    a: "chef's special blend",
    b: "chef's special mix",
    family: "unclassified",
    firstLabel: "SYNONYM",
    firstConfidence: "low",
    firstReason: "names look like variants of each other",
    residueReason: "confidence_low",
    contradictionDetail: "",
  },
];
