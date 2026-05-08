import { z } from "zod";

// PRD §12.4 — the 10 grocery sections. Mirrors GroceryListItem.sectionKey
// in artifacts/kiwi/lib/types.ts:608.
export const SectionKeySchema = z.enum([
  "produce",
  "meat_seafood",
  "dairy_eggs",
  "bakery_bread",
  "pantry",
  "canned",
  "frozen",
  "snacks",
  "household",
  "extras",
]);
export type SectionKey = z.infer<typeof SectionKeySchema>;

// D-WS5-030 / 6c-4 — predictive grocery-add categorization for the
// "Add an item" search bar. Cheap text+Zod call; debounced client-side.
export const ItemCategorizationInputSchema = z.object({
  itemText: z.string().min(1).max(140),
  // Sections currently in use on this list (helps disambiguation).
  knownSections: z.array(SectionKeySchema).optional(),
});
export type ItemCategorizationInput = z.infer<
  typeof ItemCategorizationInputSchema
>;

export const ItemCategorizationResultSchema = z.object({
  // Normalized canonical name (e.g. "tomato paste" not "tom paste").
  itemName: z.string().min(1).max(120),
  sectionKey: SectionKeySchema,
  // Suggested unit hint for the typeahead chip (e.g. "1 can").
  suggestedQuantity: z.string().max(40).optional(),
});
export type ItemCategorizationResult = z.infer<
  typeof ItemCategorizationResultSchema
>;

// PRD §12.5 / 6c-3 — ambiguous item flagging at list-generation time.
export const AmbiguousFlagInputSchema = z.object({
  itemName: z.string().min(1).max(140),
  context: z.string().max(280).optional(), // recipe context for nuance
});
export type AmbiguousFlagInput = z.infer<typeof AmbiguousFlagInputSchema>;

export const AmbiguousFlagResultSchema = z.object({
  isAmbiguous: z.boolean(),
  // Populated only when isAmbiguous; e.g. ["blueberries","strawberries"].
  ambiguityOptions: z.array(z.string().min(1).max(80)).max(8).optional(),
});
export type AmbiguousFlagResult = z.infer<typeof AmbiguousFlagResultSchema>;
