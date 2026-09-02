// WS9 D-WS9-189 Block A1 — the AI judging harness.
//
// THE REVIEW MECHANISM (ruled by Hans, August 31): an Opus judge with NO
// auto-accept-and-hide path for the answers Hans cares about — his words,
// "opus judge and call out the ones that don't look perfect." This is the
// BUG-032 pattern, which resolved a 329-row sheet Hans could not finish by
// hand. A confident, non-contradictory verdict writes its row and never reaches
// him; NO / UNSURE / low-confidence / contradiction-flagged pairs become the
// CSV, plus a marked random sample of the auto-accepted verdicts.
//
// ⚠️ THE STRUCTURAL FACT BEHIND THAT RULING: the largest review sheet Hans has
// ever completed is 23 rows, and BUG-032's 329-row sheet sat at 0/329 until a
// judge resolved it. A pipeline that hands him 300 rows will not finish. The
// residue is designed for the TENS.
//
// D-WS9-197, half 1 — FAMILY GRANULARITY. One call per food family, every pair
// in that family in the same call. The defect this fixes is real and measured:
// the model labelled `lime ~ lime juice` component and `lemon ~ lemon juice`
// distinct, at high confidence, IN THE SAME API CALL, when the batch boundary
// was arbitrary. Judged side by side as citrus, it cannot do that without the
// contradiction being visible to itself.

import Anthropic from "@anthropic-ai/sdk";

import type { Pair } from "./pairUniverse";

// Hans Ruling (BUG-032, carried forward): Opus, deliberately. The judge does
// the exact work the string matcher failed at, and capability converts directly
// into fewer poisoned rows in a table nothing downstream re-checks.
// claude-opus-5 rather than BUG-032's claude-opus-4-8: same $5/$25 per MTok,
// current Opus tier.
export const JUDGE_MODEL = "claude-opus-5";

// Bump this when the rubric text below changes. It is stamped on every row, so
// a future re-run under a revised rubric can find what the old one wrote —
// which is the whole lesson of D-WS9-197.
export const PROMPT_VERSION = "d189-a1-v4-triage";

// $ per million tokens for claude-opus-5.
export const PRICE_INPUT_PER_MTOK = 5;
export const PRICE_OUTPUT_PER_MTOK = 25;

export type Label = "SYNONYM" | "COMPONENT" | "DISTINCT" | "SUBSUMES" | "UNSURE";
export type Confidence = "high" | "medium" | "low";

export interface Verdict {
  pairIndex: number;
  label: Label;
  confidence: Confidence;
  reason: string;
  /** COMPONENT only: which endpoint is the thing you BUY. */
  baseIsA?: boolean;
  /** SUBSUMES only: which endpoint is the GENERIC. Direction is the relation. */
  genericIsA?: boolean | null;
  yieldQuantity?: number | null;
  yieldUnit?: string | null;
  coHarvestable?: boolean | null;
}

export interface JudgedPair {
  pair: Pair;
  verdict: Verdict;
  familyKey: string;
  batchSplit: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const RESPONSE_SCHEMA = {
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
          label: { type: "string", enum: ["SYNONYM", "COMPONENT", "DISTINCT", "SUBSUMES", "UNSURE"] },
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

// The rubric. Every calibration example below is a ruling Hans has already
// made, or the exact pair D-WS9-197 was opened against.
const RUBRIC = `You are building a durable table of relationships between ingredients in a recipe app's catalog. Each pair below is two rows from that catalog. Label every pair with exactly one of SYNONYM, COMPONENT, DISTINCT, or SUBSUMES.

SYNONYM — the same purchase under two names. One trip to the shelf, one product, and a shopper handed either name buys the identical thing.
  granulated sugar ~ white sugar        (the same bag)
  extra virgin olive oil ~ extra-virgin olive oil ~ EVOO ~ olive oil
  black peppercorns ~ whole black peppercorns
  mozzarella cheese ~ shredded mozzarella cheese is NOT a synonym — see DISTINCT.

COMPONENT — different ingredients, but ONE thing you buy. One is derived from the other, and buying the base yields the derived thing at no extra purchase.
  lime ~ lime juice          (you buy limes; juice comes out of them)
  lemon ~ lemon zest         (same fruit, different part)
  garlic head ~ garlic clove
  pepperoncini ~ pepperoncini brine   (one jar gives you both)

DISTINCT — different products that happen to share a word. A shopper who bought one and needed the other would have to make a second purchase.
  iodized salt / kosher salt / flaky sea salt are three DIFFERENT products — grain size IS the product, and you do not already own the one you bought for finishing.
  black peppercorns ~ ground black pepper: DISTINCT. You would have to grind them.
  canned diced tomatoes ~ canned whole peeled tomatoes: DISTINCT, two different cans.
  fresh basil ~ dried basil: DISTINCT.
  red onion ~ yellow onion: DISTINCT.

SUBSUMES — one name is GENERIC and the other is a SPECIFIC kind of it. A shopper who needs the generic is satisfied by the specific; a shopper who needs the specific is NOT satisfied by just any of the generic.
  bell peppers ~ red bell pepper        SUBSUMES  (generic = "bell peppers")
  onion ~ yellow onion                  SUBSUMES  (generic = "onion")
  chili powder ~ ancho chili powder     SUBSUMES  (generic = "chili powder")

🔴 SUBSUMES IS DIRECTED AND THE DIRECTION IS THE WHOLE POINT. Set genericIsA: true if the FIRST name is the generic one, false if the SECOND is. The reverse claim — that any bell pepper satisfies a demand for a RED bell pepper — is false, so a direction you set backwards is not a small error, it is the opposite assertion.

🔴 TWO SPECIFICS NEVER SUBSUME EACH OTHER. They are DISTINCT.
  red bell pepper ~ yellow bell pepper   -> DISTINCT. Two peppers, two lines, two purchases.
  red onion ~ yellow onion               -> DISTINCT.
Only a bare, unqualified generic subsumes. If BOTH names carry a qualifier, the answer is DISTINCT (or SYNONYM if the qualifiers mean the same thing).

🔴 QUALIFIER AXES ARE INDEPENDENT, AND THIS IS THE CASE MOST OFTEN GOT WRONG. A name can be specified on one axis (colour, size, cut, variety, origin) while unspecified on another. Two names specified on DIFFERENT axes do not subsume each other in either direction — neither one covers the other — so they are DISTINCT.
  large bell peppers ~ red bell pepper     -> DISTINCT. "large" fixes SIZE and leaves colour open;
                                              "red" fixes COLOUR and leaves size open. Neither
                                              contains the other.
  large bell peppers ~ green bell pepper   -> DISTINCT. Same reason.
  bell peppers ~ large bell peppers        -> SUBSUMES. The bare generic is unspecified on EVERY
                                              axis, so it subsumes anything qualified on any axis.
  bell peppers ~ red bell pepper           -> SUBSUMES.
Ask yourself: WHICH AXIS does each qualifier fix? Same axis, one bare -> SUBSUMES. Different axes -> DISTINCT. Do not treat a size word as though it were another colour.

🔴 AN UNQUALIFIED NAME IS NOT AUTOMATICALLY THE GENERIC, AND THIS IS THE MOST COMMON WAY SUBSUMES GOES WRONG. A bare name subsumes ONLY when the qualified variants EXHAUST it. Where the bare name instead denotes a STANDARD OR DEFAULT variety, it is a SIBLING of the qualified names, not their parent — so it is DISTINCT from them (or SYNONYM with whichever one names that same standard).

  Worked example — flour tortillas are three SIBLING SIZES, not a parent and two children:
    small flour tortillas   = taquito size
    flour tortillas         = ALL-PURPOSE: regular tacos and small burritos. This is A SIZE.
    large flour tortillas   = burrito size
  So:
    flour tortillas ~ small flour tortillas   -> DISTINCT   (siblings, not parent/child)
    flour tortillas ~ large flour tortillas   -> DISTINCT
    large flour tortillas ~ large flour tortillas (10-inch)  -> SUBSUMES. Subsumption WITHIN a
        tier is still real: "large" leaves the exact inches open and 10-inch fills it.

  The same shape, all DISTINCT rather than SUBSUMES:
    egg yolks ~ large egg yolks     ("large" is the default US egg grade, so "egg yolks" already
                                     means large ones — a sibling, not a parent)
    corn tortillas ~ small corn tortillas
    yellow onion ~ medium yellow onion

  THE TEST: if a shopper asked for the bare name, would they be happy with ANY of the qualified
  variants? If yes, it is SUBSUMES. If the bare name would get them one PARTICULAR variant —
  the standard one — then it names that variant and is DISTINCT from the others.

  ⚠️ THAT RULE HAS TWO BRANCHES AND YOU MUST NOT COLLAPSE THEM. When the bare name denotes the
  standard variety, it is DISTINCT from the OTHER variants but SYNONYM with the one that names
  that same standard:
    yellow onion ~ medium yellow onion  -> SYNONYM   (bare 'yellow onion' IS the medium bulb)
    yellow onion ~ large yellow onion   -> DISTINCT  (a different size off the shelf)
  Answering DISTINCT to both would say the standard variety differs from itself.

🔴 "THICK-CUT" AND "THIN-CUT" ARE DEFAULT-VARIETY MARKERS, NOT SIZE GRADES. Regular and thick-cut
are separate SKUs at separate prices, so the bare name does NOT subsume the cut-qualified one:
  bacon ~ thick-cut bacon                       -> DISTINCT
  sandwich bread ~ thick-cut white sandwich bread -> DISTINCT
  tortilla chips ~ thick-cut corn tortilla chips  -> DISTINCT
A shopper holding regular bacon has not satisfied a recipe that wants thick-cut. (Contrast a
genuine size grade: shrimp counts, pork-chop thickness specs and asparagus spear thickness ARE
size axes and DO subsume.)

🔴 A PREFIX PREP WORD IS A PURCHASED PREPARED PRODUCT; A COMMA-SUFFIX PREP WORD IS AN INSTRUCTION.
  shredded carrots     = a bag you buy         -> DISTINCT from `carrots`
  carrots, shredded    = something you do      -> the same purchase as `carrots`
So a prefix-prep name is never generic over the whole vegetable, and never a synonym of it.
This covers every convenience product in the catalog: shredded cheese, pre-diced onion, jarred
minced garlic, pre-cut vegetables.

THE TEST THAT SEPARATES THEM. Ask: a shopper holding one of these, who needs the other —
  needs nothing more                      -> SYNONYM
  needs nothing more, but must do work to
  extract it from what they already hold  -> COMPONENT
  is satisfied only in ONE direction,
  because one name is broader             -> SUBSUMES
  must buy something else                 -> DISTINCT

🔴 A PREPARATION QUALIFIER ("…, halved", "…, diced", "…, white parts only"): DOES IT DISCARD PART OF THE PURCHASE, OR MERELY TRANSFORM IT? This is the single most common source of inconsistent answers, so decide it by the rule and not by feel.
  TRANSFORMS — halved, chopped, sliced, diced, minced, thinly sliced, grated, crushed, torn,
    cubed, quartered. Nothing is thrown away; the whole purchase is still used, in a different
    shape. -> SYNONYM.
      roma tomatoes ~ roma tomatoes, halved            -> SYNONYM
      fresh tomatoes ~ fresh tomatoes, roughly chopped -> SYNONYM
      yellow onion ~ yellow onion, diced               -> SYNONYM
  DISCARDS — "white and light green parts only", "leaves only", "stems removed", "florets",
    "trimmed", "peeled and seeded". You buy MORE than the recipe uses; part of the purchase is
    waste. -> COMPONENT, with a yield magnitude for the part you actually use.
      leeks ~ leeks, white and light green parts only  -> COMPONENT (a leek yields roughly half)
      broccoli ~ broccoli florets                      -> COMPONENT
Ask: after the prep, is any of what I bought in the bin? No -> SYNONYM. Yes -> COMPONENT.

⚠️ JUDGE THE WHOLE FAMILY CONSISTENTLY. Every pair below is from ONE food family, and they are given to you together for exactly one reason: analogous pairs must receive analogous labels. If you call "lime ~ lime juice" COMPONENT, then "lemon ~ lemon juice" is COMPONENT too — the fruits differ, the relationship does not. Before you answer, scan your own labels for two pairs that differ only in which specific ingredient they name and check that you gave them the same label. A structural check downstream will catch it if you do not, and every pair it catches costs a human a decision.

FOR EVERY COMPONENT PAIR YOU MUST ALSO GIVE THE ARITHMETIC. A label alone says the edge exists and nothing about how much to buy, and the consolidator cannot compute a shopping quantity from that.
  baseIsA        — true if the FIRST name is the thing you buy, false if the SECOND is.
  yieldQuantity  — how much of the derived ingredient ONE unit of the base yields, as a number.
  yieldUnit      — the unit for that number ("tbsp", "tsp", "cup", "clove", "each", "g", "oz").
                   Use the unit a recipe would ask for the derived ingredient in.
  coHarvestable  — can this derivation come off the SAME physical unit as the base's OTHER
                   derivations, or does it consume the unit?
                   lemon -> juice : true   \\
                   lemon -> zest  : true   /  one lemon gives you both
                   lime  -> wedges: false     a wedge IS the fruit; it is used up
                   Set true when the base can still yield its other parts afterwards.
  Examples: lemon -> lemon juice = 3 tbsp, coHarvestable true.
            lemon -> lemon zest  = 1 tbsp, coHarvestable true.
            garlic head -> garlic clove = 10 clove, coHarvestable false.
For SYNONYM and DISTINCT pairs, set baseIsA, yieldQuantity, yieldUnit and coHarvestable all to null.

FOR SUBSUMES, set genericIsA and leave baseIsA, yieldQuantity, yieldUnit and coHarvestable null. SUBSUMES carries NO magnitude — it says a demand for the generic is met by the specific, and there is no quantity in that. "How much red bell pepper does one bell pepper yield" is not a question with an answer.
For every OTHER label, set genericIsA to null.

CONFIDENCE. "high" means you would stake the row on it. "medium" means the answer is probably right but the pair has a wrinkle. "low" means you are guessing. Use UNSURE as the label (with any confidence) only when the two names are too vague to judge at all — not when the answer is merely hard. Be honest: a low-confidence answer is routed to a human, which is the correct outcome, while a wrong high-confidence answer is written to the database and never re-examined.

Return one verdict per pair, using the pairIndex given.`;

export function buildBatchPrompt(familyKey: string, pairs: Pair[]): string {
  const lines = pairs.map(
    (p, i) => `${i}. "${p.a.canonicalName}"  ~  "${p.b.canonicalName}"`,
  );
  return `${RUBRIC}

Food family: ${familyKey}
Pairs (${pairs.length}):
${lines.join("\n")}`;
}

function coerceVerdict(raw: unknown, pairCount: number): Verdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const idx = typeof o.pairIndex === "number" ? o.pairIndex : Number.NaN;
  if (!Number.isInteger(idx) || idx < 0 || idx >= pairCount) return null;
  const label = String(o.label ?? "").toUpperCase();
  const confidence = String(o.confidence ?? "").toLowerCase();
  return {
    pairIndex: idx,
    label:
      label === "SYNONYM" || label === "COMPONENT" || label === "DISTINCT" || label === "SUBSUMES"
        ? (label as Label)
        : "UNSURE",
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? (confidence as Confidence)
        : "low",
    reason: typeof o.reason === "string" ? o.reason : "",
    baseIsA: typeof o.baseIsA === "boolean" ? o.baseIsA : undefined,
    genericIsA: typeof o.genericIsA === "boolean" ? o.genericIsA : null,
    yieldQuantity: typeof o.yieldQuantity === "number" ? o.yieldQuantity : null,
    yieldUnit: typeof o.yieldUnit === "string" && o.yieldUnit.length > 0 ? o.yieldUnit : null,
    coHarvestable: typeof o.coHarvestable === "boolean" ? o.coHarvestable : null,
  };
}

const RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Judge one family batch. Returns a verdict for every pair — a pair the model
 * omitted or a call that never landed becomes UNSURE/low, which routes it to
 * the human residue rather than dropping it. A silently missing pair would read
 * as "covered" when it was not.
 */
/**
 * Output tokens observed per pair on the A1 pilot: 101,952 output tokens across
 * 660 pairs, thinking included. Used to size max_tokens from the batch size
 * rather than from a guess.
 *
 * ⚠️ THIS IS THE REAL CONSTRAINT, and the A1 batch cap of 40 was set without
 * measuring it. Input is not close to binding: tomato's whole 224-pair family
 * is 8,720 input tokens against a 1M context window, and ALL 2,253 pairs in one
 * call would be 65,562 (6.6% of context). What actually bound the batch was
 * A1's hardcoded max_tokens of 16,000 — 224 pairs need ~34,500 output tokens
 * and would have truncated. 40 was chosen to fit that number, not any ceiling
 * the model has.
 */
const OUTPUT_TOKENS_PER_PAIR = 155;
const MIN_MAX_TOKENS = 16_000;
// claude-opus-5 caps output at 128K.
const MODEL_MAX_TOKENS = 128_000;
// Above roughly this, a non-streaming request risks an SDK HTTP timeout.
const STREAM_ABOVE = 16_000;

export function maxTokensFor(pairCount: number): number {
  const need = Math.ceil(pairCount * OUTPUT_TOKENS_PER_PAIR * 1.8);
  return Math.min(MODEL_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, need));
}

export async function judgeBatch(
  client: Anthropic,
  familyKey: string,
  pairs: Pair[],
  usage: Usage,
): Promise<Verdict[]> {
  const prompt = buildBatchPrompt(familyKey, pairs);
  const maxTokens = maxTokensFor(pairs.length);

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const request = {
        model: JUDGE_MODEL,
        // Thinking is ON BY DEFAULT on claude-opus-5, and max_tokens caps
        // thinking PLUS response text — a budget sized to the JSON alone
        // truncates mid-answer. Sized from the batch, not hardcoded.
        max_tokens: maxTokens,
        output_config: {
          effort: "high" as const,
          format: {
            type: "json_schema" as const,
            schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [{ role: "user" as const, content: prompt }],
      };

      // Streaming is mandatory above ~16K max_tokens or the request can die on
      // an HTTP timeout before the model finishes thinking.
      const message =
        maxTokens > STREAM_ABOVE
          ? await client.messages.stream(request).finalMessage()
          : await client.messages.create(request);

      usage.calls += 1;
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;

      if (message.stop_reason === "max_tokens") {
        // A truncated batch would silently lose its tail to UNSURE, which reads
        // as "the judge was uncertain" when the truth is "we cut it off".
        throw new Error(
          `batch truncated at max_tokens=${maxTokens} for ${pairs.length} pairs — raise OUTPUT_TOKENS_PER_PAIR`,
        );
      }

      if (message.stop_reason === "refusal") {
        throw new Error("judge refused");
      }

      const text = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      const parsed = JSON.parse(text) as { verdicts?: unknown[] };
      const byIndex = new Map<number, Verdict>();
      for (const raw of parsed.verdicts ?? []) {
        const v = coerceVerdict(raw, pairs.length);
        if (v && !byIndex.has(v.pairIndex)) byIndex.set(v.pairIndex, v);
      }
      // A pair the model skipped is a malformed response, not an uncertain
      // verdict — same rule as the retry path above.
      const missing = pairs.map((_, i) => i).filter((i) => !byIndex.has(i));
      if (missing.length > 0) {
        throw new Error(
          `judge batch "${familyKey}" returned no verdict for ${missing.length} of ${pairs.length} pairs`,
        );
      }
      return pairs.map((_, i) => byIndex.get(i)!);
    } catch (err) {
      if (attempt === RETRIES) {
        // 🔴 RAISE. DO NOT DEGRADE TO UNSURE.
        //
        // This path used to return UNSURE for every pair in the batch, and it
        // cost us twice: a max_tokens truncation once, and a 529
        // `overloaded_error` that turned the whole 115-pair `cheese` family into
        // "the judge was uncertain". It was not uncertain — it was never asked.
        //
        // A transient API failure and a considered "I cannot tell" are different
        // facts, and a reviewer reading the sheet cannot distinguish them once
        // both render as UNSURE. `UNSURE` must mean the judge said UNSURE.
        throw new Error(
          `judge batch "${familyKey}" (${pairs.length} pairs) failed after ${RETRIES + 1} attempts: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // ⚠️ 800ms linear backoff was too short for a 529. The full run lost the
      // whole 115-pair `cheese` family to `overloaded_error` after exhausting
      // retries — correctly routed to UNSURE rather than dropped, but a family
      // nobody judged. Exponential from 5s gives an overloaded API time to
      // recover instead of hammering it three times in 2.4 seconds.
      await sleep(5000 * 2 ** attempt);
    }
  }
  /* c8 ignore next */
  return [];
}

export function costUsd(usage: Usage): number {
  return (
    (usage.inputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK
  );
}
