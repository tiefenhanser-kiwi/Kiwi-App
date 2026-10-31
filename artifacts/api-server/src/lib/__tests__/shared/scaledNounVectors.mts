// SERVER-13 F (BUG-634) — THE SCALED-NOUN VECTORS, SHARED WITH THE CLIENT.
//
// ⚠️ .mts ON PURPOSE (CLIENT-6's feastDayVectors.mts convention): a .ts outside the
// importer's package may load as CommonJS under tsx and lose its named exports. Import
// it by the .mjs specifier; TypeScript and tsx both map it to this file:
//
//   server  src/lib/__tests__/server13ScaledNouns.test.ts, as
//           import { … } from "./shared/scaledNounVectors.mjs";
//   client  artifacts/kiwi/lib/cooking/__tests__/scaledNouns.test.ts, as
//           import { … } from "../../../../api-server/src/lib/__tests__/shared/scaledNounVectors.mjs";
//
// The server's rule is api-server src/lib/feastScaleFrames.ts (singularOf, pluralOf,
// refNounEdits); the client's port is artifacts/kiwi/lib/cooking/scaledNouns.ts
// (singularOf, pluralOf, refNounEdit). Both must give these answers.
//
// ⚠️ NO IMPORTS, NO PATH ALIASES, NO RUNTIME BEYOND LITERALS. Keep it data.

/** singularOf(word) → the singular. */
export const SINGULAR: readonly (readonly [string, string])[] = [
  ["limes", "lime"],
  ["eggs", "egg"],
  ["leaves", "leaf"],
  ["knives", "knife"],
  ["potatoes", "potato"],
  ["tomatoes", "tomato"],
  ["mangoes", "mango"],
  ["cherries", "cherry"],
  ["chilies", "chili"],
  ["chillies", "chilli"],
  ["jalapeños", "jalapeño"],
  ["peaches", "peach"],
  ["strips", "strip"],
];

/** pluralOf(word) → the plural (a word with none is itself). */
export const PLURAL: readonly (readonly [string, string])[] = [
  ["lime", "limes"],
  ["egg", "eggs"],
  ["leaf", "leaves"],
  ["loaf", "loaves"],
  ["tomato", "tomatoes"],
  ["mango", "mangoes"],
  ["cherry", "cherries"],
  ["chili", "chilies"],
  ["squash", "squashes"],
  ["round", "rounds"],
  ["fish", "fish"],
  ["zucchini", "zucchini"],
  ["dough", "dough"],
  ["powder", "powder"],
];

/**
 * A step with one unit-less amount. `ref` is the amount's exact text (its first
 * occurrence in `text`), `authored` its number as written, `shown` the number the
 * scaled plan or stepper shows, `food` the ingredient the amount belongs to (the
 * server's row name; for the client, a food of the dish). `want` is the text with
 * the noun agreed and the authored number left in place (the app swaps the number).
 */
export interface ScaledNounVector {
  name: string;
  text: string;
  ref: string;
  authored: number;
  shown: number;
  food: string;
  want: string;
}

export const STEP_VECTORS: readonly ScaledNounVector[] = [
  // SERVER-10 E / CLIENT-8 B — the rule as it was, kept.
  { name: "2 limes at 1 → lime", text: "Cut 2 limes into wedges.", ref: "2", authored: 2, shown: 1, food: "lime", want: "Cut 2 lime into wedges." },
  { name: "1 egg at 2 → eggs", text: "Push the noodles aside and crack in 1 egg, then scramble.", ref: "1", authored: 1, shown: 2, food: "large eggs", want: "Push the noodles aside and crack in 1 eggs, then scramble." },
  { name: "2 eggs at 1 → egg", text: "Push the noodles aside and crack in 2 eggs, then scramble.", ref: "2", authored: 2, shown: 1, food: "large eggs", want: "Push the noodles aside and crack in 2 egg, then scramble." },
  { name: "1 garlic clove at 2 → cloves (a count noun)", text: "Mince 1 garlic clove and set aside.", ref: "1", authored: 1, shown: 2, food: "garlic", want: "Mince 1 garlic cloves and set aside." },
  { name: "2 bay leaves at 1 → leaf", text: "Add 2 bay leaves to the pot.", ref: "2", authored: 2, shown: 1, food: "bay leaves", want: "Add 2 bay leaf to the pot." },
  { name: "the plural head names the food, never a modifier after it", text: "Halve 1 avocado lengthwise and remove the pit.", ref: "1", authored: 1, shown: 2, food: "avocado", want: "Halve 1 avocados lengthwise and remove the pit." },
  { name: "unchanged when the count stays on its side of one", text: "Cut 3 limes into wedges.", ref: "3", authored: 3, shown: 2, food: "lime", want: "Cut 3 limes into wedges." },
  // SERVER-13 F (BUG-634).
  { name: "a range keeps its plural", text: "Place 1–2 fish strips on each warmed tortilla.", ref: "1–2", authored: 1.5, shown: 0.75, food: "cod fillets", want: "Place 1–2 fish strips on each warmed tortilla." },
  { name: "a range with a hyphen keeps its plural", text: "Tuck 2-3 Roma tomato wedges beside each dog.", ref: "2-3", authored: 2.5, shown: 0.625, food: "Roma tomatoes", want: "Tuck 2-3 Roma tomato wedges beside each dog." },
  { name: "mangoes at 1 → mango, not mangoe", text: "Peel and dice the 2 ripe mangoes into ½-inch cubes.", ref: "2", authored: 2, shown: 1, food: "mango", want: "Peel and dice the 2 ripe mango into ½-inch cubes." },
  { name: "chilies at 1 → chili, not chily", text: "Thinly slice the 2 serrano chilies.", ref: "2", authored: 2, shown: 1, food: "serrano chilies", want: "Thinly slice the 2 serrano chili." },
  { name: "chili at 2 → chilies", text: "Thinly slice 1 red chili with the seeds removed.", ref: "1", authored: 1, shown: 2, food: "red chili", want: "Thinly slice 1 red chilies with the seeds removed." },
  { name: "the counted noun after a food is the head: dough round → rounds, not doughs", text: "Press 1 refrigerated pie dough round into a 9-inch pie dish.", ref: "1", authored: 1, shown: 2, food: "refrigerated pie dough", want: "Press 1 refrigerated pie dough rounds into a 9-inch pie dish." },
  { name: "a mass noun has no plural", text: "Stir in 1 onion powder and the paprika.", ref: "1", authored: 1, shown: 2, food: "onion powder", want: "Stir in 1 onion powder and the paprika." },
];
