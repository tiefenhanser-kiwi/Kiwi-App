// WS7-8b BUG-003 Block 1 — deterministic step→ingredient reference matcher.
//
// Pure, no DB, no AI. Given a step's rendered text and the dish's own
// DishIngredient rows, derives the sidecar `amountRefs` (which text span maps
// to which ingredient's structured amount) and an `unmatchedAmount` flag that
// drives the Block-1 "an amount looks off" signal.
//
// DESIGN (locked with Hans, Phase 0):
//   - ref.quantity is the step's AUTHORED LITERAL at base servings (0.75 for
//     "¾ cup"), NOT the DishIngredient canonical total. Partial/split steps
//     ("the remaining ¾ cup") then render correctly when scaled by the meal
//     detail's multiplier. ingredientId carries the structural link.
//   - References are DERIVED here at materialize time. The AI is unchanged.
//   - DISH-OWNED steps only (the caller passes a dish's ingredients).
//
// Three measured refinements (Phase 0b) are implemented:
//   (a) name-primary, quantity-confirmatory-NOT-required — a unique name match
//       wins even when the step amount differs from the canonical total.
//   (b) nearest-name-to-the-right positional resolution for enumerated lists
//       ("1 tsp cumin, 1 tsp chili powder").
//   (c) coalesce adjacent number tokens before matching ("1½", not "1"+"½").
// Plus (d) a LOCAL hardened QUANTITY_RE: a word boundary after unit words so
//   bare "g" stops matching the "g" in "garlic". The shared cookSession regex
//   is intentionally left untouched in Block 1 (latent bug → D-WS7-172, WS9).

export interface MatcherIngredient {
  ingredientId: string;
  name: string; // displayName || canonicalName
  quantity: number;
  unit: string;
}

// Persisted shape (one element of the `amountRefs Json?` array).
export interface AmountRef {
  ingredientId: string;
  quantity: number; // authored literal at base servings (see DESIGN)
  unit: string; // the span's unit text as written ("" when the span had none)
  charStart: number;
  charEnd: number;
}

export interface DeriveAmountRefsResult {
  amountRefs: AmountRef[];
  // true when the step has ≥1 non-by-design amount that resolves to no unique
  // ingredient — drives the subtle, non-blocking Block-1 signal. DERIVED, never
  // persisted (D4): the only schema column is `amountRefs`.
  unmatchedAmount: boolean;
}

// ── detector (mirrors cookSession.ts:261-278, LOCAL + hardened) ──────────────

const UNIT_WORDS = [
  "cups?", "tbsps?", "tablespoons?", "tsps?", "teaspoons?",
  "cloves?", "ozs?", "ounces?", "lbs?", "pounds?",
  "grams?", "g", "kgs?", "kilograms?",
  "mls?", "milliliters?", "millilitres?", "ls?", "liters?", "litres?",
  "pinch(?:es)?", "cans?", "sticks?", "slices?", "pieces?", "sprigs?",
  "minutes?", "mins?", "hours?", "hrs?", "seconds?", "secs?",
];
const NUMBER = String.raw`\d+(?:[.,]\d+)?(?:\s*[\/\-–]\s*\d+(?:[.,]\d+)?)?|[½¼¾⅓⅔⅛⅜⅝⅞]`;
// (d) `(?![a-zA-Z])` after the unit so "3 garlic" → "3", never "3 g".
const QUANTITY_RE = new RegExp(
  `(?:${NUMBER})(?:\\s*(?:${UNIT_WORDS.join("|")})(?![a-zA-Z]))?`,
  "gi",
);
const NUMBER_RE = new RegExp(NUMBER, "");
const TIME_UNIT_RE = /^(minutes?|mins?|hours?|hrs?|seconds?|secs?)$/i;

const VULGAR: Record<string, number> = {
  "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

interface Span {
  start: number;
  end: number;
  text: string;
  num: number | null;
  unit: string; // matched unit text, lowercased ("" when none)
}

function parseNumber(s: string): number | null {
  const m = s.match(NUMBER_RE);
  if (!m) return null;
  let t = m[0].trim();
  if (VULGAR[t] !== undefined) return VULGAR[t];
  const range = t.split(/\s*[\-–]\s*/);
  if (range.length === 2 && range[0] && range[1]) {
    const a = parseNumber(range[0]);
    const b = parseNumber(range[1]);
    if (a != null && b != null) return (a + b) / 2;
  }
  if (t.includes("/")) {
    const [a, b] = t.split("/").map((x) => Number(x.replace(",", ".")));
    if (b) return a / b;
  }
  t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function extractUnit(matched: string): string {
  const m = matched.match(NUMBER_RE);
  if (!m) return "";
  return matched.slice((m.index ?? 0) + m[0].length).trim().toLowerCase();
}

/** Detect amount spans, then (c) coalesce a bare integer + adjacent fraction. */
function detectSpans(text: string): Span[] {
  const raw = [...text.matchAll(QUANTITY_RE)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    text: m[0],
  }));
  const merged: { start: number; end: number; text: string }[] = [];
  for (const r of raw) {
    if (!r.text) continue;
    const prev = merged[merged.length - 1];
    const gap = prev ? text.slice(prev.end, r.start) : "";
    const prevIsBareInt = prev && /^\d+$/.test(prev.text.trim());
    const curStartsFraction = /^[½¼¾⅓⅔⅛⅜⅝⅞]/.test(r.text) || /^\d+\s*\//.test(r.text);
    if (prev && prevIsBareInt && /^\s{0,2}$/.test(gap) && curStartsFraction) {
      prev.end = r.end;
      prev.text = text.slice(prev.start, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged.map((m) => {
    let num = parseNumber(m.text);
    const mix = m.text.match(/^(\d+)\s*([½¼¾⅓⅔⅛⅜⅝⅞])/);
    if (mix) num = Number(mix[1]) + VULGAR[mix[2]];
    return { start: m.start, end: m.end, text: m.text, num, unit: extractUnit(m.text) };
  });
}

function normalizeUnit(u: string): string {
  const x = u.toLowerCase().replace(/\.$/, "").trim();
  const map: Record<string, string> = {
    cup: "cup", cups: "cup", tbsp: "tbsp", tbsps: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
    tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp", clove: "clove", cloves: "clove",
    oz: "oz", ozs: "oz", ounce: "oz", ounces: "oz", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
    g: "g", gram: "g", grams: "g", kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg",
    ml: "ml", mls: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
    l: "l", ls: "l", liter: "l", liters: "l", litre: "l", litres: "l",
    can: "can", cans: "can", stick: "stick", sticks: "stick", slice: "slice", slices: "slice",
    piece: "piece", pieces: "piece", sprig: "sprig", sprigs: "sprig", pinch: "pinch", pinches: "pinch",
    whole: "", count: "", unit: "", each: "each", "": "",
  };
  return map[x] ?? x;
}

// Prep/structure words skipped when reading the name phrase around an amount.
const PREP = new Set([
  "softened", "drained", "rinsed", "chopped", "diced", "sliced", "minced", "ground",
  "fresh", "large", "small", "medium", "thawed", "room", "temperature", "cold", "warm",
  "hot", "packed", "heaping", "level", "generous", "about", "approximately", "remaining",
  "additional", "extra", "more", "each", "the", "of", "and", "a", "an", "to", "into",
  "until", "for", "in", "on", "or", "with", "then", "evenly", "lightly", "well", "your",
]);
function contentTokens(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/s$/, ""))
    .filter((t) => t.length >= 3 && !PREP.has(t) && !PREP.has(t + "s"));
}
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/s$/, ""))
    .filter((t) => t.length >= 3 && !PREP.has(t));
}

/**
 * A span is "by-design" — a number that is NOT an ingredient amount and must
 * get NO ref and NEVER set unmatchedAmount: times (incl. hyphenated
 * "12-minute"), temperatures ("375°F", "preheat to 375"), and structural
 * dims/counts ("9×13", "1/4-inch", "3 wedges").
 */
function isByDesign(text: string, span: Span): boolean {
  const after = text.slice(span.end, span.end + 14);
  const before = text.slice(Math.max(0, span.start - 14), span.start).toLowerCase();
  if (TIME_UNIT_RE.test(span.unit) || /^-\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i.test(after)) {
    return true;
  }
  if (
    /^\s*(?:°|º|degrees?|deg\b)/i.test(after) ||
    (/^\s*[°º]?\s*[fc]\b/i.test(after) && /\d/.test(span.text)) ||
    (/(preheat|oven|reduce heat to|heat to)/.test(before) && span.num != null && span.num >= 100)
  ) {
    return true;
  }
  if (
    /^\s*(?:×|x\s*\d|["”″]|-?\s*inch(?:es)?\b|-?\s*in\b|-?\s*cm\b|-?\s*mm\b)/i.test(after) ||
    /^\s*(?:wedges?|patties|pattie|balls?|rounds?|sheets?|portions?|servings?|equal\b|even\b|squares?|strips?|halves|quarters?|thirds?)/i.test(after) ||
    /(\d)\s*[×x]\s*$/.test(text.slice(Math.max(0, span.start - 4), span.start))
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve a (non-by-design) amount span to exactly one ingredient, or null if
 * it is a genuine ingredient amount that resolves nowhere (→ unmatched).
 */
function resolveSpan(text: string, span: Span, ings: MatcherIngredient[]): MatcherIngredient | null {
  const toks = ings.map((iv) => ({ iv, tokens: nameTokens(iv.name) }));
  const u = normalizeUnit(span.unit);
  const qtyUnitAgrees = (iv: MatcherIngredient) =>
    span.num != null &&
    Math.abs(iv.quantity - span.num) < 0.05 &&
    (normalizeUnit(iv.unit) === u || normalizeUnit(iv.unit) === "" || u === "");

  // Break a position-tie: most tokens matched, then quantity+unit confirmatory.
  const pickWinner = (
    cands: { iv: MatcherIngredient; pos: number; ov: number }[],
    best: (xs: number[]) => number,
  ): MatcherIngredient | null => {
    if (cands.length === 0) return null;
    const bestPos = best(cands.map((c) => c.pos));
    let top = cands.filter((c) => c.pos === bestPos);
    if (top.length === 1) return top[0].iv; // (a) name-primary: qty NOT required
    const maxOv = Math.max(...top.map((c) => c.ov));
    top = top.filter((c) => c.ov === maxOv);
    if (top.length === 1) return top[0].iv;
    const conf = top.filter((c) => qtyUnitAgrees(c.iv)); // (a) qty CONFIRMATORY
    return conf.length === 1 ? conf[0].iv : null;
  };

  // (b) nearest-name-to-the-right — the ingredient whose name token appears
  // EARLIEST (closest to the amount) wins, NOT the one with the most tokens.
  // "1 pound ground beef and ½ yellow onion" → "1 pound" binds to beef
  // (adjacent), not onion (more tokens, but farther).
  const rightRaw = text.slice(span.end, span.end + 45).split(/[,.;]| then | until | over | for | in /i)[0];
  const rightTokens = contentTokens(rightRaw); // ordered
  const rightCands = toks
    .map((c) => {
      let pos = Infinity, ov = 0;
      for (const t of c.tokens) {
        const idx = rightTokens.indexOf(t);
        if (idx >= 0) { ov++; pos = Math.min(pos, idx); }
      }
      return { iv: c.iv, pos, ov };
    })
    .filter((c) => c.ov > 0);
  if (rightCands.length > 0) return pickWinner(rightCands, (xs) => Math.min(...xs));

  // amount-after-name fallback ("salsa, ¾ cup") — nearest to the LEFT = latest.
  const leftRaw = text.slice(Math.max(0, span.start - 35), span.start).split(/[,.;]| and /i).pop() ?? "";
  const leftTokens = contentTokens(leftRaw); // ordered
  const leftCands = toks
    .map((c) => {
      let pos = -1, ov = 0;
      for (const t of c.tokens) {
        const idx = leftTokens.lastIndexOf(t);
        if (idx >= 0) { ov++; pos = Math.max(pos, idx); }
      }
      return { iv: c.iv, pos, ov };
    })
    .filter((c) => c.ov > 0);
  if (leftCands.length > 0) return pickWinner(leftCands, (xs) => Math.max(...xs));

  // A content noun was present but matched no ingredient → genuine miss. (No
  // qty+unit fallback — it would mis-bind to an unrelated same-quantity row.)
  if (rightTokens.length > 0) return null;
  // No name phrase at all → qty+unit-unique fallback.
  const qc = ings.filter(qtyUnitAgrees);
  return qc.length === 1 ? qc[0] : null;
}

/**
 * Derive the sidecar references + unmatched flag for one dish-owned step.
 * Pure: same (text, ingredients) → same output. Never throws.
 */
export function deriveAmountRefs(
  stepText: string,
  ingredients: MatcherIngredient[],
): DeriveAmountRefsResult {
  const amountRefs: AmountRef[] = [];
  let unmatchedAmount = false;

  for (const span of detectSpans(stepText)) {
    if (isByDesign(stepText, span)) continue; // no ref, never flags
    const ing = resolveSpan(stepText, span, ingredients);
    if (ing && span.num != null) {
      amountRefs.push({
        ingredientId: ing.ingredientId,
        quantity: span.num, // authored literal at base servings (D3)
        unit: span.unit, // span's own unit text ("" when unitless)
        charStart: span.start,
        charEnd: span.end,
      });
    } else {
      unmatchedAmount = true;
    }
  }

  return { amountRefs, unmatchedAmount };
}

/**
 * Read-side derivation of the unmatched signal (D4: never stored). Reuses the
 * SAME detector, so it stays consistent with what was persisted.
 *   - amountRefs === null → legacy/unwired step → always false (plain render).
 *   - otherwise → true iff a non-by-design amount span is NOT covered by any
 *     stored ref (i.e. a real ingredient amount that resolved to no ingredient).
 * Ingredient rows are NOT needed here — coverage is decided against the stored
 * ref char-spans alone.
 */
export function hasUnmatchedAmount(stepText: string, amountRefs: unknown): boolean {
  if (amountRefs == null || !Array.isArray(amountRefs)) return false;
  const refs = amountRefs as AmountRef[];
  for (const span of detectSpans(stepText)) {
    if (isByDesign(stepText, span)) continue;
    const covered = refs.some((r) => r.charStart <= span.start && r.charEnd >= span.end);
    if (!covered) return true;
  }
  return false;
}
