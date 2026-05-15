// WS6 6c-4 Block B — AI wrappers over the deterministic grocery list.
//
// Three exports:
//   - gapFillPurchaseSize: single-call Haiku gap-fill for one ingredient.
//   - fillPurchaseSizesWithWriteBack: walks a ConsolidatedItem[], hits the
//     cache (Ingredient.purchaseUnit/Quantity/Display when present), calls
//     gapFillPurchaseSize for cache misses, writes the result back to the
//     Ingredient row when ingredientId is non-null, and returns the filled
//     list. Items with ingredientId === null still get the AI fill applied
//     in-memory but skip the DB write (no row to update).
//   - generateFinalGroceryList: Sonnet final polish over the filled list.
//     Enforces "AI must not add items" — throws if the output count exceeds
//     the input count (decreases via merge are allowed and expected).
//
// On AI failure these helpers throw GroceryListAIError. The route layer in
// Block C catches and surfaces a user-readable message; smoke tests assert
// the propagation directly.

import Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient, StoreSection } from "@prisma/client";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  GenerateGroceryListResultSchema,
  PurchaseSizeResultSchema,
  type GenerateGroceryListInput,
  type GenerateGroceryListResult,
  type PurchaseSizeInput,
  type PurchaseSizeResult,
  type SectionKey,
} from "./ai/schemas/grocery";
import type { ConsolidatedItem } from "./groceryList";

export class GroceryListAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroceryListAIError";
  }
}

export interface GroceryListAIOptions {
  prisma: PrismaClient;
  userId: string;
  // DI seam for tests. Production callers omit and runAICall builds its own
  // module-level Anthropic client from process.env.ANTHROPIC_API_KEY.
  client?: Pick<Anthropic, "messages">;
}

/**
 * Single-ingredient purchase-size gap-fill (Haiku). Pure AI call — no DB
 * write. See {@link fillPurchaseSizesWithWriteBack} for the cached +
 * write-back variant. Throws GroceryListAIError on failure.
 */
export async function gapFillPurchaseSize(
  input: PurchaseSizeInput,
  opts: GroceryListAIOptions,
): Promise<PurchaseSizeResult> {
  const result = await productionRunAICall(
    "grocery.gap_fill_purchase_size",
    { gapFillInput: input },
    PurchaseSizeResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );
  if (!result.success) {
    throw new GroceryListAIError(result.userFacingMessage);
  }
  return result.data;
}

/**
 * For each item with missing purchase fields:
 *   - If all three purchase fields are populated, treat as a cache hit and
 *     pass through unchanged (no AI call, no DB write).
 *   - Otherwise call grocery.gap_fill_purchase_size, write the result back
 *     to the Ingredient row when ingredientId is non-null, and apply the
 *     fill in-memory.
 *
 * Items with ingredientId === null skip write-back (synthetic recurring
 * entries from Block A's consolidator have no Ingredient row to update)
 * and fill ephemerally.
 *
 * Returns a new array — does not mutate input items.
 */
export async function fillPurchaseSizesWithWriteBack(
  items: ConsolidatedItem[],
  opts: GroceryListAIOptions,
): Promise<ConsolidatedItem[]> {
  const filled: ConsolidatedItem[] = [];
  for (const item of items) {
    if (
      item.purchaseUnit !== null &&
      item.purchaseQuantity !== null &&
      item.purchaseDisplay !== null
    ) {
      filled.push(item);
      continue;
    }
    const result = await gapFillPurchaseSize(
      {
        canonicalName: item.canonicalName,
        requestedQuantity: item.quantity,
        requestedUnit: item.unit,
      },
      opts,
    );
    if (item.ingredientId !== null) {
      await opts.prisma.ingredient.update({
        where: { id: item.ingredientId },
        data: {
          purchaseUnit: result.purchaseUnit,
          purchaseQuantity: result.purchaseQuantity,
          purchaseDisplay: result.purchaseDisplay,
        },
      });
    }
    filled.push({
      ...item,
      purchaseUnit: result.purchaseUnit,
      purchaseQuantity: result.purchaseQuantity,
      purchaseDisplay: result.purchaseDisplay,
    });
  }
  return filled;
}

/**
 * Final AI polish pass (Sonnet). Takes the deterministic + gap-filled list
 * and returns the shopper-ready final list with refined displayNames,
 * reconciled unit mismatches, and reassigned 'extras'-bucketed items.
 *
 * Block B contract:
 *   - Preserves all three boolean flags exactly (the prompt enforces this;
 *     the test layer asserts pass-through).
 *   - Does NOT add items. Helper throws GroceryListAIError if the AI returns
 *     more items than the input. Decreases (via merge) are allowed — the
 *     prompt explicitly authorizes same-canonicalName merges.
 *   - Does NOT mutate input items.
 */
export async function generateFinalGroceryList(
  planTitle: string,
  items: ConsolidatedItem[],
  knownSections: StoreSection[],
  opts: GroceryListAIOptions,
): Promise<GenerateGroceryListResult> {
  const input: GenerateGroceryListInput = {
    planTitle,
    consolidated: items.map((item) => ({
      canonicalName: item.canonicalName,
      displayName: item.displayName,
      quantity: item.quantity,
      unit: item.unit,
      sectionKey: item.sectionKey as SectionKey,
      isUniversalStaple: item.isUniversalStaple,
      isUserPantryStaple: item.isUserPantryStaple,
      isRecurringItem: item.isRecurringItem,
      purchaseUnit: item.purchaseUnit,
      purchaseQuantity: item.purchaseQuantity,
      purchaseDisplay: item.purchaseDisplay,
      // 6c-5: recipe-context signals for AI form inference + ambiguity.
      preparationNote: item.preparationNote,
      sourceDishTitle: item.sourceDishTitle,
    })),
    knownSections: knownSections as SectionKey[],
  };

  const result = await productionRunAICall(
    "grocery.generate_list",
    { generateInput: input },
    GenerateGroceryListResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );
  if (!result.success) {
    throw new GroceryListAIError(result.userFacingMessage);
  }
  if (result.data.items.length > items.length) {
    throw new GroceryListAIError(
      `AI returned ${result.data.items.length} items but input had ${items.length}; item count must not increase.`,
    );
  }
  return result.data;
}
