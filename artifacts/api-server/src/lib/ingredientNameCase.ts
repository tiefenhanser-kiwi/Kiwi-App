// [grocery] B2 BUG-323 — THE CASING RULE, in production.
//
// A display name that opens with a capital on a COMMON noun is a sentence
// fragment pretending to be a label: the list read "Bell peppers", "Chicken
// thighs", "Salt" beside "bell peppers", "chicken thighs", "salt" depending on
// which row the wizard happened to mint first. 116 of 1,780 catalog rows.
//
// D-WS9-230, Hans verbatim: "on any fixes, there is NO NEED to backfill or fix
// data … it's all my data". The carve-out that makes this a fix at all: "would a
// new user signing up tomorrow inherit this row?" The shared CATALOG is fixed;
// `GroceryListItem` rows are user data and are left alone, all 1,359 of them.
//
// ⚠️ THE RULE TOUCHES THE FIRST CHARACTER ONLY. "Plain Greek yogurt" becomes
// "plain Greek yogurt" — the interior capital is somebody's nationality and none
// of this rule's business. A rule that lowercased every token would have to know
// English, and this one deliberately does not.
//
// ⚠️ THIS FILE IS THE ONE LIST. `scripts/grocery-b2/proposals.ts` re-exports it
// rather than keeping a copy: the same rule has to decide the one-time catalog
// fix and every row minted afterwards, or the catalog re-accumulates exactly the
// way it did the first time (which is how BUG-096's alias table earned its
// existence).

/**
 * Leading tokens that KEEP their capital. Reviewed on the Part A digest and ruled
 * by Hans on September 28, one numbered line each.
 *
 * It is a list of PROPER NOUNS AS THEY APPEAR FIRST IN A NAME, not a general
 * exception vocabulary: "Greek" is here because "Greek yogurt or mayo" opens with
 * it, and "plain Greek yogurt" keeps its interior "Greek" through the
 * first-character rule rather than through this list.
 *
 * "Basmati" was on this list until the go-ahead ruled it off (digest #419):
 * basmati is a rice variety and takes no capital. Removed rather than commented
 * out, so nothing re-adds it by habit.
 */
export const PROPER_NOUN_LEADS: readonly string[] = [
  "American", "Asian", "Belgian", "Brussels", "Caesar", "Cajun",
  "Cheese", "Chinese", "Chinkiang", "Cotija", "Creole", "English", "Frank's",
  "French", "Fritos", "Granny", "Greek", "Guinness", "Hatch", "Hawaiian",
  "Honeycrisp", "Italian", "Italian-seasoned", "Italian-style", "Japanese",
  "Kalamata", "Kashmiri", "Madras", "Mexican", "Near", "New", "Oaxacan",
  "Old", "Panang", "Parmesan", "Parmigiano-Reggiano", "Pecorino", "Persian",
  "Pico", "Ritz", "San", "Shaoxing", "Sichuan", "Spanish", "St.", "Swiss",
  "Szechuan", "T-bone", "Thai", "Yukon",
];

const LEADS = new Set(PROPER_NOUN_LEADS);

/**
 * Lowercase the leading character unless the leading token is a proper noun.
 * Idempotent, and a no-op on a name that already starts lowercase.
 */
export function lowercaseLead(displayName: string): string {
  const lead = displayName.trim().split(/\s+/)[0] ?? "";
  if (LEADS.has(lead)) return displayName;
  if (!/^[A-Z]/.test(displayName)) return displayName;
  return displayName.charAt(0).toLowerCase() + displayName.slice(1);
}
