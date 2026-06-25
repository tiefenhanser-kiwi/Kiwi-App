// PRD §11.3 — quantity rounding for cooking-measure display. Shared by the
// Meal Detail ingredient scaler and the WS7-8b BUG-003 step amount-ref render
// so step amounts and ingredient amounts round identically.
// Approximate; per-unit precision is a polish pass (WS9).

export function formatQuantity(qty: number, unit: string): string {
  const wholeUnits = ["whole", "clove"];
  if (wholeUnits.includes(unit.toLowerCase())) {
    return String(Math.ceil(qty));
  }
  // Round to nearest 1/8 for cooking measures.
  const rounded = Math.round(qty * 8) / 8;
  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  const fracMap: Record<string, string> = {
    "0.125": "⅛",
    "0.250": "¼",
    "0.375": "⅜",
    "0.500": "½",
    "0.625": "⅝",
    "0.750": "¾",
    "0.875": "⅞",
  };
  const fracKey = frac.toFixed(3);
  const fracStr = fracMap[fracKey] ?? "";
  if (whole === 0 && fracStr) return fracStr;
  if (whole > 0 && fracStr) return `${whole}${fracStr}`;
  if (whole > 0 && !fracStr) return String(whole);
  // Fallback: tiny non-mappable fraction (shouldn't happen after 1/8 rounding).
  return rounded.toFixed(2);
}
