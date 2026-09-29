// [grocery] B2 Part C — H3's RIDER, and the ONE grammar for it.
//
// Hans, September 28: "ONLY if there's a meal that says 'bell peppers' would we
// do '5 bell peppers, at least 2 red and at least 2 yellow.' … the big piece is
// that we do buy what the recipe says, but if it's generic it says 'get whatever
// generic, but be sure you get these specific varieties because your recipes
// called those out'."
//
// ⚠️ WHY THE RIDER LIVES IN `displayName` AND NOT IN A COLUMN.
//
// The shopper's line is composed on the PHONE, from `GroceryListItem.displayName`
// plus the pack fields. There is no other channel to it: adding one is a schema
// change plus a wire change plus a client change, and the client is outside this
// block's fence. So the rider is appended to the name, and the retailer hand-off
// parses it back off.
//
// THAT PARSE IS SAFE FOR ONE REASON AND IT IS WORTH STATING: the rider is
// MACHINE-WRITTEN, by `composeVarietyRider` below, and nothing else in the
// codebase writes a `, at least N x` clause onto an ingredient name. The grammar
// is fixed, both directions live in this file, and a round-trip test pins them
// together. If a later block adds a column for this, delete the parse — do not
// leave two mechanisms.
//
// ⚠️ THE SEARCH TERM IS ALREADY HANDLED, AND BY ACCIDENT OF AN EARLIER FIX.
// `instacartSearchName` (retailers/instacartName.ts) drops a trailing
// comma-clause whose first word is a PREP_WORD, and "at" is in PREP_WORDS. So
// "bell peppers, at least 2 green" already searches as "bell peppers" with no
// change at all. Asserted by test rather than relied on quietly.

/** One variety the generic line has to guarantee, and how many of it. */
export interface VarietyShare {
  /** The words that distinguish the variety — "red", "bone-in", "san marzano". */
  variety: string;
  /** Whole units of the LINE's buy unit. Never a measure (H3). */
  count: number;
}

const RIDER_ONE = /^at least (\d+) (.+)$/;

/**
 * "at least 2 green and at least 1 yellow".
 *
 * Returns "" for an empty share list, so a caller can append unconditionally.
 */
export function composeVarietyRider(shares: readonly VarietyShare[]): string {
  const parts = shares
    .filter((s) => s.variety.trim().length > 0 && s.count > 0)
    .map((s) => `at least ${Math.max(1, Math.ceil(s.count))} ${s.variety.trim()}`);
  return parts.join(" and ");
}

/** The whole line name: "bell peppers, at least 2 green and at least 1 yellow". */
export function appendVarietyRider(
  baseName: string,
  shares: readonly VarietyShare[],
): string {
  const rider = composeVarietyRider(shares);
  return rider.length > 0 ? `${baseName}, ${rider}` : baseName;
}

/**
 * The inverse. Splits a composed line name back into the generic and its shares;
 * a name with no rider comes back with an empty share list and its name intact.
 *
 * Deliberately strict: the clause after the LAST comma must parse as one or more
 * `at least N x` joined by " and ", or nothing is taken. A real ingredient name
 * containing a comma ("parmesan cheese, finely grated") therefore survives
 * untouched, which is the failure this strictness exists to prevent.
 */
export function parseVarietyRider(displayName: string): {
  base: string;
  shares: VarietyShare[];
} {
  const idx = displayName.lastIndexOf(", at least ");
  if (idx < 0) return { base: displayName, shares: [] };
  const base = displayName.slice(0, idx);
  const clause = displayName.slice(idx + 2);
  const shares: VarietyShare[] = [];
  for (const piece of clause.split(" and ")) {
    const m = RIDER_ONE.exec(piece.trim());
    if (!m) return { base: displayName, shares: [] }; // not our grammar — leave it alone
    shares.push({ variety: m[2].trim(), count: Number(m[1]) });
  }
  return shares.length > 0 ? { base, shares } : { base: displayName, shares: [] };
}

/**
 * H7 — "An H3 line is sent as SEPARATE items … The display line stays one line."
 *
 * Given the composed name and the line's total count, returns what the retailer
 * order should contain: one item per called-out variety at its guaranteed count,
 * plus the REMAINDER at the generic name. The remainder is what the shopper is
 * free to choose, and it is omitted when the shares account for the whole line.
 *
 * `5 bell peppers, at least 2 red and at least 2 yellow` ->
 *   { name: "red bell peppers",    quantity: 2 }
 *   { name: "yellow bell peppers", quantity: 2 }
 *   { name: "bell peppers",        quantity: 1 }
 *
 * The variety name is composed as "<variety> <generic>" rather than stored,
 * because the generic is the noun and the variety is what was added to it — the
 * same relation `distinguishingTokens` measures in the other direction.
 */
export function splitRiderForRetailer(
  displayName: string,
  totalCount: number,
): { name: string; quantity: number }[] {
  const { base, shares } = parseVarietyRider(displayName);
  if (shares.length === 0) return [{ name: displayName, quantity: Math.max(1, Math.round(totalCount)) }];
  const out: { name: string; quantity: number }[] = [];
  let claimed = 0;
  for (const s of shares) {
    out.push({ name: `${s.variety} ${base}`.trim(), quantity: s.count });
    claimed += s.count;
  }
  const remainder = Math.max(0, Math.round(totalCount) - claimed);
  if (remainder > 0) out.push({ name: base, quantity: remainder });
  return out;
}
