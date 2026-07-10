// PRD §11.3 — quantity rounding for cooking-measure display. Shared by the
// Meal Detail ingredient scaler and the WS7-8b BUG-003 step amount-ref render
// so step amounts and ingredient amounts round identically.
// Approximate; per-unit precision is a polish pass (WS9).

// WS7-8b fraction-glyph block — shared vulgar-fraction map. Eighths give the
// fine-grained "need" granularity B1's ⅛ ladder emits; thirds (⅓/⅔) are kept
// because cooks recognize them and they are NOT representable as eighths.
// `value` is the exact fractional part; `glyph` its Unicode vulgar fraction.
const FRACTION_GLYPHS: ReadonlyArray<{ value: number; glyph: string }> = [
  { value: 1 / 8, glyph: "⅛" },
  { value: 1 / 4, glyph: "¼" },
  { value: 1 / 3, glyph: "⅓" },
  { value: 3 / 8, glyph: "⅜" },
  { value: 1 / 2, glyph: "½" },
  { value: 5 / 8, glyph: "⅝" },
  { value: 2 / 3, glyph: "⅔" },
  { value: 3 / 4, glyph: "¾" },
  { value: 7 / 8, glyph: "⅞" },
];

// Nearest-glyph tolerance. Wide enough that lightly-rounded inputs still match
// (1.667 → ⅔, |0.667 − 0.6667| ≈ 3e-4), tight enough that a genuine non-glyph
// decimal stays unmatched (1.9 → frac 0.9 is > ε from ⅞ 0.875, so it falls
// back to its decimal). Half the smallest gap between adjacent glyphs
// (⅓→⅜ = 0.0417, ⅝→⅔ = 0.0417) is ~0.021 — 0.02 keeps matches disjoint.
const GLYPH_EPSILON = 0.02;

// Return the glyph whose value is within ε of `frac`, or null. When two glyphs
// are within ε (only possible if ε were too wide), the nearest wins.
function matchGlyph(frac: number): string | null {
  let best: { glyph: string; dist: number } | null = null;
  for (const { value, glyph } of FRACTION_GLYPHS) {
    const dist = Math.abs(frac - value);
    if (dist <= GLYPH_EPSILON && (best === null || dist < best.dist)) {
      best = { glyph, dist };
    }
  }
  return best?.glyph ?? null;
}

/**
 * WS7-8b fraction-glyph block — grocery NEED-quantity display formatter.
 *
 * Maps a numeric need quantity to a shopper-friendly amount string with a
 * Unicode vulgar-fraction glyph (1.125 → "1⅛", 1.333… → "1⅓", 0.5 → "½").
 * ε-EXACT: only values that land on a known fraction (eighths ∪ thirds) within
 * GLYPH_EPSILON are glyphed; anything else — including an off-ladder AI-merge
 * value — falls back to its plain decimal string (1.9 → "1.9"), never an
 * invented glyph. Amount-only; the caller appends the unit.
 *
 * Display-only: callers must NOT feed this back into an editor or persist it —
 * it is lossy for non-glyph fractions and emits non-parseable glyph chars.
 */
export function formatNeedGlyph(qty: number): string {
  if (!Number.isFinite(qty)) return String(qty);
  if (Number.isInteger(qty)) return String(qty);

  const sign = qty < 0 ? "-" : "";
  const abs = Math.abs(qty);
  const whole = Math.floor(abs);
  const frac = abs - whole;

  const glyph = matchGlyph(frac);
  if (!glyph) return String(qty); // off-glyph → plain decimal fallback

  if (whole === 0) return `${sign}${glyph}`; // bare fraction, no leading 0
  return `${sign}${whole}${glyph}`;
}

export function formatQuantity(qty: number, unit: string): string {
  const wholeUnits = ["whole", "clove"];
  if (wholeUnits.includes(unit.toLowerCase())) {
    return String(Math.ceil(qty));
  }

  const whole = Math.floor(qty);
  const frac = qty - whole;

  // WS7-8b — thirds first: ⅓/⅔ are not representable as eighths, so match them
  // before the eighth-rounding below (which would otherwise mangle ⅓→⅜, ⅔→⅝).
  if (Math.abs(frac - 1 / 3) <= GLYPH_EPSILON) {
    return whole === 0 ? "⅓" : `${whole}⅓`;
  }
  if (Math.abs(frac - 2 / 3) <= GLYPH_EPSILON) {
    return whole === 0 ? "⅔" : `${whole}⅔`;
  }

  // Round to nearest 1/8 for cooking measures (approximate — WS9 polish).
  const rounded = Math.round(qty * 8) / 8;
  const rWhole = Math.floor(rounded);
  const rFrac = rounded - rWhole;
  const fracMap: Record<string, string> = {
    "0.125": "⅛",
    "0.250": "¼",
    "0.375": "⅜",
    "0.500": "½",
    "0.625": "⅝",
    "0.750": "¾",
    "0.875": "⅞",
  };
  const fracKey = rFrac.toFixed(3);
  const fracStr = fracMap[fracKey] ?? "";
  if (rWhole === 0 && fracStr) return fracStr;
  if (rWhole > 0 && fracStr) return `${rWhole}${fracStr}`;
  if (rWhole > 0 && !fracStr) return String(rWhole);
  // Fallback: tiny non-mappable fraction (shouldn't happen after 1/8 rounding).
  return rounded.toFixed(2);
}
