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
import { formatQuantity } from "../format/quantity";

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
    const scaled = formatQuantity(r.quantity * multiplier, r.unit);
    out.push({ text: r.unit ? `${scaled} ${r.unit}` : scaled, isRef: true });
    cursor = r.charEnd;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), isRef: false });
  return out.length > 0 ? out : [{ text, isRef: false }];
}
