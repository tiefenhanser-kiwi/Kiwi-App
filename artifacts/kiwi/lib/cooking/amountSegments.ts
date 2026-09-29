// WS7-8b BUG-003 Block 1 — render-time segmentation of a step's text using its
// derived amountRefs. Where highlightQuantities (cookSession.ts) is a
// regex-based, LOSSLESS reconstruction of the original literal, this builder
// REPLACES each ref span with the structured amount scaled by the meal-detail
// multiplier — so a rescale renders from one structured source and the step's
// literal is never shown.
//
// Used by:
//   - Meal Detail (the scaling screen): multiplier = displayServings/servings.
//   - Cook Mode: multiplier = 1 (renders the structured base amount; Cook Mode
//     does not scale — only the literal is bypassed in favor of the ref value).

import type { AmountRef } from "../api/meals";
import { pluralizeUnitWord } from "../format/grocery";
import { displayedQuantity, formatQuantity } from "../format/quantity";

// ── WS9 BUG-326 — A RANGE IS NOT ITS MIDPOINT ──────────────────────────────
//
// The catalog's amount extractor resolves an authored range to a single
// number, and the number it picks is the MIDDLE: "3–4 shallow cuts" carries
// `quantity: 3.5`, "2–3 tablespoons" carries 2.5. This builder then replaces
// the authored span with that number, so the cook reads "3½ shallow cuts" and
// "2.5 tablespoons" — an instruction no recipe has ever contained, and for a
// countable thing an impossible one.
//
// The ref is not WRONG as data: a midpoint is a reasonable scalar for a range,
// and the grocery consolidation wants a scalar. It is wrong as PROSE. So the
// guard is render-side and narrow: when the span's AUTHORED TEXT holds a range,
// that text is what the step shows, and the structured value is not consulted.
//
// ⚠️ `isRef` STAYS TRUE. The span is still an amount and still earns the
// terracotta treatment — it is the author's amount rather than the derived one.
// Flipping it to plain text would silently de-highlight 68 steps.
//
// ⚠️ SCALING LEAVES A RANGE AS WRITTEN (ruled). There is no honest way to scale
// "2–3 tablespoons" by 1.5: scaling both ends invents a range the author did
// not write, and scaling the midpoint is the defect. A range is a tolerance,
// not a quantity, so it rides through the servings stepper untouched.
const NUM = String.raw`\d+(?:\.\d+)?`;
/** An authored range: "3-4", "2–3", "60 to 70". Hyphen, en/em dash, or "to". */
const AUTHORED_RANGE = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}`);

/** Does this span's authored text state a range rather than one amount? */
export function spanHoldsRange(spanText: string): boolean {
  return AUTHORED_RANGE.test(spanText);
}

export interface AmountSegment {
  text: string;
  /** true → a structured ref amount (style it terracotta); false → plain text. */
  isRef: boolean;
}

/**
 * Slice `text` into plain + ref segments. Refs are taken in document order on
 * their char-spans; each ref span's text becomes the scaled structured amount
 * (`ref.quantity × multiplier`, rounded by formatQuantity) plus its unit.
 *
 * Defensive: ignores refs with out-of-range or overlapping spans so a bad
 * payload can never drop or reorder characters of the surrounding prose. When
 * no usable ref remains, returns a single plain segment === the original text.
 */
export function buildAmountRefSegments(
  text: string,
  amountRefs: AmountRef[] | null | undefined,
  multiplier: number,
): AmountSegment[] {
  if (!amountRefs || amountRefs.length === 0) {
    return [{ text, isRef: false }];
  }
  const refs = [...amountRefs]
    .filter(
      (r) =>
        Number.isInteger(r.charStart) &&
        Number.isInteger(r.charEnd) &&
        r.charStart >= 0 &&
        r.charEnd <= text.length &&
        r.charStart < r.charEnd,
    )
    .sort((a, b) => a.charStart - b.charStart);

  const out: AmountSegment[] = [];
  let cursor = 0;
  for (const r of refs) {
    if (r.charStart < cursor) continue; // skip overlap — never mangle prose
    if (r.charStart > cursor) out.push({ text: text.slice(cursor, r.charStart), isRef: false });
    const authored = text.slice(r.charStart, r.charEnd);
    if (spanHoldsRange(authored)) {
      // BUG-326 — the author wrote a range; print the range.
      out.push({ text: authored, isRef: true });
    } else {
      const amount = r.quantity * multiplier;
      const scaled = formatQuantity(amount, r.unit);
      // BUG-321 — the unit is a WORD here, same as on an ingredient line, and
      // pluralized on the DISPLAYED amount so "1 cups" cannot happen.
      const unit = r.unit
        ? pluralizeUnitWord(r.unit, displayedQuantity(amount, r.unit))
        : "";
      out.push({ text: unit ? `${scaled} ${unit}` : scaled, isRef: true });
    }
    cursor = r.charEnd;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), isRef: false });
  return out.length > 0 ? out : [{ text, isRef: false }];
}
