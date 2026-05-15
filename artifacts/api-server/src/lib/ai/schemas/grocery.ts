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

// D-WS5-030 / 6c-6 — predictive grocery-add categorization for the
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

// === 6c-4 Block B — grocery.gap_fill_purchase_size ===
// Map a single recipe ingredient need to its standard purchase size. Haiku,
// called once per ingredient missing purchaseUnit/Quantity/Display on the
// Ingredient row. Result is written back to the Ingredient row by the
// fillPurchaseSizesWithWriteBack helper so subsequent plans hit the cache.

export const PurchaseSizeInputSchema = z.object({
  canonicalName: z.string().min(1).max(100),
  requestedQuantity: z.number().positive(),
  requestedUnit: z.string().min(1).max(40),
});
export type PurchaseSizeInput = z.infer<typeof PurchaseSizeInputSchema>;

export const PurchaseSizeResultSchema = z.object({
  purchaseUnit: z.string().min(1).max(40),
  purchaseQuantity: z.number().positive(),
  purchaseDisplay: z.string().min(1).max(80),
  confidence: z.enum(["high", "medium", "low"]),
});
export type PurchaseSizeResult = z.infer<typeof PurchaseSizeResultSchema>;

// === 6c-4 Block B / 6c-5 — grocery.generate_list ===
// Final AI polish pass over the deterministic + gap-filled list. Sonnet.
// Refines displayNames, reconciles unit-mismatch survivors, reassigns
// extras-bucketed items to correct sections. Preserves all three boolean
// flags exactly; does NOT add items (helper enforces count never increases).
// 6c-5: input now carries preparationNote + sourceDishTitle so the AI can
// infer specific defaults for vague items and flag ambiguity in-line.

export const GenerateListInputItemSchema = z.object({
  canonicalName: z.string(),
  displayName: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  sectionKey: SectionKeySchema,
  isUniversalStaple: z.boolean(),
  isUserPantryStaple: z.boolean(),
  isRecurringItem: z.boolean(),
  purchaseUnit: z.string().nullable(),
  purchaseQuantity: z.number().nullable(),
  purchaseDisplay: z.string().nullable(),
  // 6c-5: recipe-context signals for AI form inference + ambiguity flagging.
  preparationNote: z.string().nullable(),
  sourceDishTitle: z.string().nullable(),
});
export type GenerateListInputItem = z.infer<typeof GenerateListInputItemSchema>;

export const GenerateGroceryListInputSchema = z.object({
  planTitle: z.string(),
  consolidated: z.array(GenerateListInputItemSchema),
  knownSections: z.array(SectionKeySchema),
});
export type GenerateGroceryListInput = z.infer<
  typeof GenerateGroceryListInputSchema
>;

// 6c-5: ambiguityOptions is optional (omitted when not flagged) but when
// isAmbiguous is true it MUST be present with 2-4 entries. The .refine
// below enforces the joint constraint at the per-item layer so the route
// can trust the contract without an extra guard.
export const GenerateListOutputItemSchema = z
  .object({
    canonicalName: z.string(),
    displayName: z.string(),
    quantity: z.number().positive(),
    unit: z.string(),
    sectionKey: SectionKeySchema,
    isUniversalStaple: z.boolean(),
    isUserPantryStaple: z.boolean(),
    isRecurringItem: z.boolean(),
    notes: z.string().nullable(),
    isAmbiguous: z.boolean(),
    ambiguityOptions: z.array(z.string()).min(2).max(4).optional(),
    wasAiInferred: z.boolean(),
  })
  .refine(
    (it) =>
      !it.isAmbiguous ||
      (Array.isArray(it.ambiguityOptions) &&
        it.ambiguityOptions.length >= 2 &&
        it.ambiguityOptions.length <= 4),
    {
      message:
        "ambiguityOptions must be a 2-4 entry array when isAmbiguous is true",
      path: ["ambiguityOptions"],
    },
  );
export type GenerateListOutputItem = z.infer<
  typeof GenerateListOutputItemSchema
>;

export const GenerateGroceryListResultSchema = z.object({
  items: z.array(GenerateListOutputItemSchema),
});
export type GenerateGroceryListResult = z.infer<
  typeof GenerateGroceryListResultSchema
>;
