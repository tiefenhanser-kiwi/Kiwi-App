// SAFE-1 (D-WS9-315) — the ONE food-safety and shopping fragment every AI path
// that writes a recipe carries.
//
// Hans, October 15: "'wtf, AI told me to eat raw chicken' would be bad." The
// shared catalog meets the doneness rule since CAT-Q1, but TRIAGE-0 found no
// shared safety text in any live writer: the wizard, Ask Kiwi, the builder and
// import never stated 165°F or "don't rinse". This constant is that text.
//
// WHERE IT LIVES. A compiled constant, not a seeded block: the seed has no
// shared-block mechanism (each AIPromptVersion row is one whole body), and the
// precedent for a rule shared across bodies is a TS constant interpolated into
// each (CLEANUP_CLAIM_RULES, WHY_BULLETS_RULES in prisma/seeds/aiPrompts.ts).
// Interpolated there, it lands in each seeded body (a reseed bumps every body
// that carries it); interpolated into storeFillPrompts.ts's shared preamble, it
// rides the compiled store-fill prefixes (a deploy, not a reseed).
//
// THE RULES (sources, reused not reinvented):
//   1 doneness  D-WS9-315 verbatim in substance (poultry 165°F and ground meat
//               160°F always stated, below the minimum never; pork 145°F with a
//               rest; whole cuts of beef and lamb to the named doneness; fish
//               145°F or "flakes") — the wording is the CAT-Q1 editor's
//               (scripts/_scratch/cat-q1/editor.ts). Sous vide counts the come-up
//               (CAT-Q1 follow-up B: cat-q1/sousVide.ts — 60 minutes to core for
//               a piece up to 1½ inches thick, plus the FSIS hold at the bath
//               temperature, rounded up to the next half hour).
//   2 rinse     thx2Core FINALIZE_RULES (e) and the CAT-Q1 editor.
//   3 pan       thx2Core GENERATE_RULES (1) / FINALIZE_RULES (b), the vessel
//               sizes without the feast-only ones.
//   4 produce   thx2Core GENERATE_RULES (3) and the CAT-Q1 editor's citrus rule.
//
// ⚠️ Import is the user's own recipe and gets IMPORT_SAFETY_RULES instead: the
// doneness minimums only where the source has none, no rinse added, and no
// produce rewrite (the import body's "never re-portion" wins).
//
// ⚠️ Editing this text changes every body that carries it: a reseed bumps the
// six seeded writers, and the store-fill prefixes (and their sha256 pin in
// thx2StoreOptions.test.ts) move with the next deploy.

/** Rule 1 — the minimums, phrased once for both the fragment and import. */
export const DONENESS_MINIMUMS =
  "chicken, turkey, duck and every other poultry 165°F in the thickest part; ground meat (burgers, meatballs, meatloaf, crumbled ground beef, pork or lamb) 160°F in the center, ground turkey or chicken 165°F";

export const RECIPE_SAFETY_RULES = `# Food safety and shopping (the same four rules in every Kiwi recipe)

Write these into the ingredients and steps themselves; never restate them as a caveat.

1. DONENESS. The step that finishes cooking poultry or ground meat names the thermometer and the number, in these words: "...and an instant-read thermometer reads 165°F". The minimums: ${DONENESS_MINIMUMS}. That includes crumbled ground meat for tacos or a sauce ("cook, breaking it up, until no pink remains and an instant-read thermometer reads 160°F"), meatballs finished in a sauce, and chicken in a soup, curry or braise. Keep the visual cue too; the number is what the cook trusts. Pork chops, tenderloin, loin and pork roasts: 145°F, then rest 3 minutes. Whole cuts of beef and lamb (steaks, roasts, chops) cook to the doneness the recipe names; medium-rare at 130–135°F is fine, so never push a steak to 145°F. Fish: 145°F or until it flakes easily with a fork. Never write a poultry, ground-meat or pork doneness temperature BELOW its minimum, not even as a pull temperature: a cook stops at the first number. The one exception is a sous vide bath, which may run lower because the time does the work: for sous vide poultry or pork the bath time must cover the come-up as well as the hold, so allow 1 hour for a piece up to 1½ inches thick to reach the bath temperature plus the hold at that temperature (chicken at 140°F: 2 hours in all; at 145–155°F: 1½ hours; pork at 140–145°F: 1½ hours), and say in the bath step that holding at that temperature for the full time is what makes it safe. That sentence is a sous vide recipe's doneness check: the meat comes out at the bath temperature, so never tell the cook a thermometer will read more than the bath.

2. NEVER RINSE RAW POULTRY. Don't rinse chicken, turkey, the giblets or the cavity (rinsing splashes bacteria around the sink); pat it dry with paper towels.

3. FIT THE PAN. Every pan, pot, sheet or dish a step names must hold its food the way the step describes: a 12-inch skillet sears 4 chops or fillets, 6 to 8 chicken thighs, 4 burger patties or about 1½ lb of cut-up meat in one layer, or sautés about 1½ lb of vegetables; a rimmed sheet pan roasts about 2 lb in one layer; a 9×13 dish holds about 12 cups. Add up the pounds going into each pan: 2 lb of sausages with 2 lb of peppers and onions is two sheet pans, not one. When the servings need more, name the second pan or cook in batches, and say so in the step.

4. BUY PRODUCE WHOLE. List produce the way a shopper buys it: whole lemons, limes and oranges (with "juiced", "zested" or "zest, then juice" as the preparation note, never a separate "lemon juice" or "lemon zest" line), whole onions and shallots by count, and garlic in cloves (or heads). The measured amount goes in the step: "Squeeze 2 tablespoons juice from the lemon", "Add 1 cup of the diced onion".`;

/**
 * Import's lighter version: the source is the user's own recipe. The minimums
 * only where the source gives none (or a lower one), its own doneness kept
 * everywhere else, nothing about rinsing added, its produce untouched.
 */
export const IMPORT_SAFETY_RULES = `# Doneness in an imported recipe

The recipe is the user's own: keep it, and change only what a safe result needs.
- When a step cooks poultry or ground meat and the source gives no internal temperature, add one to \`stepTextTranslated\` as an instant-read thermometer check: ${DONENESS_MINIMUMS}. When the source states a LOWER number for these, write the minimum instead and add a caveat ("Raised the chicken to 165°F").
- Every other doneness the source names stays as written: a steak cooked medium-rare stays medium-rare, fish that cooks "until it flakes" stays that way, and a temperature the source already gives at or above the minimum is kept.
- Add no rinsing step and no other instruction the source does not have.
- Do not re-portion or rewrite the source's ingredient lines to make them safer or easier to shop: a "3 tablespoons lemon juice" line stays a lemon-juice line (the ingredient rules below: the quantity is the source's).`;
