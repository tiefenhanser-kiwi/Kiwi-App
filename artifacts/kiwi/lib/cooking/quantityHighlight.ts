// WS7-8b Block 4 (Block 1) — shared inline-quantity highlighter.
//
// Lifted VERBATIM from cookSession.ts (single-meal Cook Mode) so the Week Prep
// screen (Screen 3) can highlight quantities in combined-prep step prose with
// the SAME best-effort, guaranteed-reconstruct behavior. Pure; no logic change
// from the original — cookSession.ts re-exports these for back-compat so every
// existing import (and its tests) keeps resolving.

export interface TextSegment {
  text: string;
  isQuantity: boolean;
}

// Allowlisted units only, so we never bold an arbitrary trailing word. Time
// units included so cook-step durations ("4 minutes") highlight too.
const UNIT_WORDS = [
  "cups?", "tbsps?", "tablespoons?", "tsps?", "teaspoons?",
  "cloves?", "ozs?", "ounces?", "lbs?", "pounds?",
  "grams?", "g", "kgs?", "kilograms?",
  "mls?", "milliliters?", "millilitres?", "ls?", "liters?", "litres?",
  "pinch(?:es)?", "cans?", "sticks?", "slices?", "pieces?", "sprigs?",
  "minutes?", "mins?", "hours?", "hrs?", "seconds?", "secs?",
];

// A number form: integer, decimal (1.5 / 1,5), simple fraction (1/2), range
// (2-3 / 2–3), or a unicode vulgar fraction — optionally followed by an
// allowlisted unit. The `g` flag drives String.matchAll (which does not mutate
// lastIndex, so the shared regex is safe across calls).
const NUMBER = String.raw`\d+(?:[.,]\d+)?(?:\s*[\/\-–]\s*\d+(?:[.,]\d+)?)?|[½¼¾⅓⅔⅛⅜⅝⅞]`;
const QUANTITY_RE = new RegExp(
  `(?:${NUMBER})(?:\\s*(?:${UNIT_WORDS.join("|")}))?`,
  "gi",
);

/**
 * Split step text into plain + quantity segments for render-time bolding.
 *
 * GUARANTEE: `highlightQuantities(t).map(s => s.text).join("") === t` for every
 * input — segments are sliced contiguously on match indices, so no character is
 * ever dropped, reordered, or mangled. No match → a single plain segment. Never
 * throws. Full step text is always reconstructable (8a recovery path).
 */
export function highlightQuantities(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(QUANTITY_RE)) {
    const start = m.index ?? 0;
    const matched = m[0];
    if (!matched) continue; // defensive: never emit a zero-length match
    if (start > last) out.push({ text: text.slice(last, start), isQuantity: false });
    out.push({ text: matched, isQuantity: true });
    last = start + matched.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), isQuantity: false });
  return out.length > 0 ? out : [{ text, isQuantity: false }];
}
