// ── 🔴 BUG-339 — AN INTERNAL MARKER REACHED A USER'S SCREEN ─────────────────
//
// chat-Claude's browser pass, September 30: the Prep & Cook header rendered the
// plan's tag chips as
//
//     fully-specified · family-friendly · mexican · asian · classic
//
// `fully-specified` is not a description of a dinner. It is Tell Kiwi's
// `parsedIntent.scenario` — the wizard's internal classification of how
// completely the USER described what they wanted (vague / fully_specified /
// partial / unclear / overflow, `ai/schemas/tellKiwi.ts:71`).
//
// HOW IT GOT THERE, and it is not a bug in any of our code. A plan candidate's
// `tags` is a FREE-TEXT array the model writes — "1-5 short tags", with the
// prompt's own examples being cuisines and techniques — and the same prompt
// tells the model the request's scenario several times. The model wrote the word
// it had just been given. Nothing validated it, because nothing can: the field
// is deliberately open vocabulary, which is why 158 templates carry 590 tag
// values in 100-odd shapes.
//
// MEASURED, so the scope is known rather than guessed. Across the whole dev
// catalog exactly TWO templates carry a scenario word, both `fully-specified`;
// the other four scenario values appear nowhere, and `meal.tags` (1,975 rows,
// 3,335 values) and `dish.tags` (4,706 rows, 216 values) carry none at all. So
// this is a plan-template leak, and a rare one — which is precisely why a
// filter is the right shape and a migration is not. The next model run can
// write `overflow` tomorrow.
//
// ⚠️ THE TAG STAYS STORED (ruled). Filtering at READ means no write path has to
// be trusted, no backfill can miss a row, and a stored value stays available to
// anything internal that might want it. The cost is that every user-facing
// emitter has to call this — which is why it is one exported function and not a
// condition copied five times.
//
// ⚠️ EXACT-STRING ON A NORMALISED FORM, NEVER A SUBSTRING. The same discipline
// NEVER_ORDER_CANONICALS and STAPLE_VARIANT_TO_BASE keep, for the same reason: a
// substring rule on "partial" would eat a legitimate tag, and the open
// vocabulary here guarantees one eventually exists. `fully_specified` and
// `fully-specified` are one value reached by two spellings, so the normaliser
// folds `_` and `-` rather than both being listed.

/** The wizard's `parsedIntent.scenario` vocabulary — the source of the leak. */
const INTERNAL_TAGS: ReadonlySet<string> = new Set([
  "vague",
  "fully specified",
  "partial",
  "unclear",
  "overflow",
]);

/** Lowercase, trim, and fold `_`/`-` to a space, so the five values above cover
 *  every spelling the model can emit for one of them. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/** Is this tag one of the wizard's internal scenario markers? */
export function isInternalTag(tag: string): boolean {
  return INTERNAL_TAGS.has(normalizeTag(tag));
}

/**
 * The tags a USER may see. Every server-side emitter of a plan/template tag
 * list calls this; the stored column is untouched.
 *
 * Returns a new array only when something was removed, so the common case —
 * every tag public, which is 156 of 158 templates — costs one pass and no
 * allocation beyond it.
 */
export function publicTags(tags: readonly string[] | null | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const out = tags.filter((t) => !isInternalTag(t));
  return out.length === tags.length ? [...tags] : out;
}
