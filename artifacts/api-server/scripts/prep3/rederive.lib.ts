// PREP-3 (R5) — the re-derive's pure parts (rederive.ts; the tests import them).
import { countWithSize } from "../../src/lib/stepAmountRefs";

/** "four 6 oz … fillets" → "four 6-oz … fillets": the held size joined to its unit (same length). */
export function joinSizes(text: string): string {
  let out = text;
  for (const c of countWithSize(text).reverse()) {
    const size = out.slice(c.sizeStart, c.sizeEnd);
    const joined = size.replace(/^(\(?)([\d½¼¾⅓⅔.]+(?:\s*[½¼¾])?)\s+(oz|ounces?|lbs?|pounds?|g|grams?)$/i, "$1$2-$3");
    out = out.slice(0, c.sizeStart) + joined + out.slice(c.sizeEnd);
  }
  return out;
}

/** After a size: the package it is the size of ("-oz can", " oz jar", "-ounce package"). */
export const PACKAGE_AFTER = /^\s*-?\s*(?:oz|ounces?|lbs?|pounds?|fl\.? oz)?\s*(?:cans?|jars?|packages?|bags?|box(?:es)?|cartons?|containers?|bottles?|pouch(?:es)?|tubs?)\b/i;
