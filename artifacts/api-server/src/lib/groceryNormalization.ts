// WS6 6c-4 Block A — Light normalization for ingredient/staple matching.
// Lowercase, trim, strip leading article ("the "/"a "), collapse whitespace.
// Does NOT stem, pluralize, or handle synonyms — those are deferred
// (D-WS6-064 candidate). Block B's AI pass handles fuzzier reconciliation.

export function normalizeIngredientName(raw: string): string {
  // Order: lowercase → collapse whitespace → trim → strip leading article.
  // (Trimming before the strip is required: "  THE  Olive  Oil  " would
  // otherwise leave a stray leading space after the article strip and
  // break idempotency.)
  return raw.toLowerCase().replace(/\s+/g, " ").trim().replace(/^(the |a )/, "");
}
