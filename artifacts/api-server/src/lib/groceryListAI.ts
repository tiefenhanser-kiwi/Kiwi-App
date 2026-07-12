// WS6 6c-4 Block B — AI wrappers over the deterministic grocery list.
//
// Three exports:
//   - gapFillPurchaseSize: single-call Haiku gap-fill for one ingredient.
//   - fillPurchaseSizesWithWriteBack: walks a ConsolidatedItem[], hits the
//     cache (Ingredient.purchaseUnit/Quantity/Display when present), and for
//     cache misses fans out gap-fill calls in parallel (Promise.all). The
//     resulting purchase fields are written back via a SINGLE batched
//     prisma.$transaction so 50 concurrent per-row updates become one
//     round-trip envelope. Items with ingredientId === null fill ephemerally
//     and skip write-back (synthetic recurring entries have no row).
//   - generateFinalGroceryList: WS7-5d Block 3 Fix A — partitions items into
//     a deterministic pass + an AI subset (vague canonicals, extras-bucket
//     survivors, unit-mismatch survivors per PRD §12.4). The deterministic
//     side builds final output items locally (with Fix B pack-display
//     formatting via formatPackDisplay). Only the AI subset reaches Sonnet,
//     shrinking the output ~5-10× and pulling the call well under the 4096
//     max_tokens ceiling that caused the live 502. When the AI subset is
//     empty the Sonnet call is skipped entirely. Enforces "AI must not add
//     items" both locally (against subset size) and globally (against input
//     size).
//
// On AI failure these helpers throw GroceryListAIError. The route layer in
// Block C catches and surfaces a user-readable message; smoke tests assert
// the propagation directly.

import Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient, StoreSection } from "@prisma/client";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  GenerateGroceryListResultSchema,
  ItemCategorizationInputSchema,
  ItemCategorizationResultSchema,
  PurchaseSizeResultSchema,
  type GenerateGroceryListInput,
  type GenerateGroceryListResult,
  type GenerateListOutputItem,
  type ItemCategorizationResult,
  type PurchaseSizeInput,
  type PurchaseSizeResult,
  type SectionKey,
} from "./ai/schemas/grocery";
import type { ConsolidatedItem } from "./groceryList";
import {
  resolveConversion,
  scalePurchaseForSubUnit,
} from "./ingredientConversions";
import { roundNeedQuantity } from "./needQuantity";

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
 * WS7-5d Block 3 Fix C — gap-fill calls fan out via Promise.all (unbounded;
 * post-Blocks-1-2 the cache-miss residue is small and runAICall handles 429
 * retries) and write-backs batch into a single prisma.$transaction instead
 * of N concurrent UPDATEs. Original order is preserved in the returned
 * array.
 *
 * Returns a new array — does not mutate input items.
 */
export async function fillPurchaseSizesWithWriteBack(
  items: ConsolidatedItem[],
  opts: GroceryListAIOptions,
): Promise<ConsolidatedItem[]> {
  // Identify cache misses up-front, preserving their original positions.
  const missIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (
      it.purchaseUnit === null ||
      it.purchaseQuantity === null ||
      it.purchaseDisplay === null
    ) {
      missIndices.push(i);
    }
  }

  if (missIndices.length === 0) {
    return items.slice();
  }

  const missItems = missIndices.map((i) => items[i]);
  // Fan out gap-fill calls. Unbounded Promise.all by design — Block 3 sized
  // the typical residue at ≤5 items after Blocks 1-2 seeded the common
  // canonicals; runAICall retries on 429 if a future plan trips a rate
  // limit. A bounded semaphore is a one-liner away if telemetry surfaces a
  // need.
  const results = await Promise.all(
    missItems.map((item) =>
      gapFillPurchaseSize(
        {
          canonicalName: item.canonicalName,
          requestedQuantity: item.quantity,
          requestedUnit: item.unit,
        },
        opts,
      ),
    ),
  );

  // Batch write-back. Skip items with no Ingredient row (synthetic
  // recurring entries). Single $transaction envelope replaces the prior
  // serial N×UPDATE pattern; the audit flagged the concurrent-UPDATE
  // alternative explicitly.
  const writeBackOps: Promise<unknown>[] = [];
  for (let k = 0; k < missItems.length; k++) {
    const item = missItems[k];
    const r = results[k];
    if (item.ingredientId !== null) {
      writeBackOps.push(
        opts.prisma.ingredient.update({
          where: { id: item.ingredientId },
          data: {
            purchaseUnit: r.purchaseUnit,
            purchaseQuantity: r.purchaseQuantity,
            purchaseDisplay: r.purchaseDisplay,
          },
        }),
      );
    }
  }
  if (writeBackOps.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await opts.prisma.$transaction(writeBackOps as any);
  }

  // Build the output array preserving original order — items not in
  // missIndices pass through unchanged.
  const filled = items.slice();
  for (let k = 0; k < missIndices.length; k++) {
    const idx = missIndices[k];
    const r = results[k];
    filled[idx] = {
      ...items[idx],
      purchaseUnit: r.purchaseUnit,
      purchaseQuantity: r.purchaseQuantity,
      purchaseDisplay: r.purchaseDisplay,
    };
  }
  return filled;
}

// WS7-5d Block 3 Fix A — vague canonical names that always reach the AI for
// form-inference + ambiguity flagging per PRD §12.4. Everything else with a
// specific canonical name + populated purchase fields is handled
// deterministically. Conservative list — additions over time will widen the
// AI residue; trimming would force more items through Sonnet.
const VAGUE_CANONICALS = new Set<string>([
  "chicken",
  "beef",
  "pork",
  "turkey",
  "lamb",
  "fish",
  "meat",
  "berries",
  "vegetables",
  "greens",
  "yogurt",
  "bread",
  "cheese",
  // Generic recipe-side "tomatoes" without a qualifier ("diced", "crushed",
  // "cherry") — the qualified forms route to deterministic Canned/Produce
  // sections via the seed/inferCategory map.
  "tomatoes",
]);

function isVague(item: ConsolidatedItem): boolean {
  return VAGUE_CANONICALS.has(item.canonicalName.toLowerCase().trim());
}

/**
 * WS7-5d Block 3 Fix B — pack-display formatter for deterministic-path
 * items. Returns a shopper-facing displayName that surfaces the purchase
 * pack ("1 can (28 oz) crushed tomatoes", "1 lb chicken breast",
 * "2 lemons", "1 dozen eggs").
 *
 * Format A with an "each"-dup elide rule:
 *   - purchaseDisplay null → displayName unchanged (genuine unknown).
 *   - purchaseUnit === "each" AND purchaseDisplay's word-residue equals
 *     displayName, displayName+"s", or displayName+"es" → return
 *     purchaseDisplay alone ("2 lemons", "3 tomatoes", "1 cucumber").
 *   - purchaseUnit === "each" + qualifier mismatch ("yellow onion" vs.
 *     "2 onions") → return displayName alone (avoid "2 onions yellow onion").
 *   - otherwise → prepend purchaseDisplay
 *     ("1 can (28 oz) crushed tomatoes", "1 lb chicken breast",
 *     "1 dozen eggs").
 */
export function formatPackDisplay(
  displayName: string,
  purchaseUnit: string | null,
  purchaseDisplay: string | null,
): string {
  if (!purchaseDisplay) return displayName;

  if (purchaseUnit === "each") {
    const residue = purchaseDisplay
      .toLowerCase()
      .replace(/^\d+(?:\.\d+)?\s+/, "")
      .trim();
    const name = displayName.toLowerCase().trim();
    if (residue === name || residue === `${name}s` || residue === `${name}es`) {
      return purchaseDisplay;
    }
    return displayName;
  }

  return `${purchaseDisplay} ${displayName}`;
}

interface PartitionedItem {
  item: ConsolidatedItem;
  index: number;
}

interface PartitionResult {
  deterministic: PartitionedItem[];
  aiSubset: PartitionedItem[];
}

/**
 * WS7-5d Block 3 Fix A — Filter-then-AI partition. Items that must still
 * reach the Sonnet pass per PRD §12.4:
 *   1. Vague canonical names (form-inference + ambiguity flagging).
 *   2. sectionKey === "extras" (let Sonnet try to reassign to a real
 *      section; CATEGORY_TO_SECTION's 9-category map handles the common
 *      cases deterministically post-Block-1, so this should be a rare tail).
 *   3. Any item sharing a canonical name with another item but a different
 *      unit (rule-2 unit-mismatch reconciliation needs BOTH rows together,
 *      so both partner into the AI subset as a pair).
 *
 * Everything else partitions to the deterministic side and gets its final
 * displayName via formatPackDisplay (Fix B) without any AI call.
 */
export function partitionForAI(items: ConsolidatedItem[]): PartitionResult {
  const unitsByCanonical = new Map<string, Set<string>>();
  for (const item of items) {
    const c = item.canonicalName;
    let units = unitsByCanonical.get(c);
    if (!units) {
      units = new Set();
      unitsByCanonical.set(c, units);
    }
    units.add(item.unit);
  }
  const sameCanonicalDifferentUnit = new Set<string>();
  for (const [c, units] of unitsByCanonical) {
    if (units.size > 1) sameCanonicalDifferentUnit.add(c);
  }

  const deterministic: PartitionedItem[] = [];
  const aiSubset: PartitionedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (
      isVague(item) ||
      item.sectionKey === "extras" ||
      sameCanonicalDifferentUnit.has(item.canonicalName)
    ) {
      aiSubset.push({ item, index: i });
    } else {
      deterministic.push({ item, index: i });
    }
  }
  return { deterministic, aiSubset };
}

function buildDeterministicOutputItem(
  item: ConsolidatedItem,
): GenerateListOutputItem {
  // WS7-8b B2 — head↔clove purchase scaling (BUG-025-1). When the need is in a
  // sub-unit (30 cloves) and the pack is sold by the parent (head), scale the
  // pack to the number a shopper actually buys ("3 heads"), not "1 head".
  const conv = resolveConversion(item.canonicalName, item.conversionRef);
  const scaled = scalePurchaseForSubUnit(conv, item.quantity, item.unit);
  const purchaseUnit = scaled ? conv!.subUnit!.parent : item.purchaseUnit;
  const purchaseDisplay = scaled ? scaled.purchaseDisplay : item.purchaseDisplay;
  return {
    canonicalName: item.canonicalName,
    displayName: formatPackDisplay(
      item.displayName,
      purchaseUnit,
      purchaseDisplay,
    ),
    quantity: item.quantity,
    unit: item.unit,
    sectionKey: item.sectionKey as SectionKey,
    isUniversalStaple: item.isUniversalStaple,
    isUserPantryStaple: item.isUserPantryStaple,
    isRecurringItem: item.isRecurringItem,
    notes: null,
    isAmbiguous: false,
    wasAiInferred: false,
  };
}

/**
 * WS7-5d Block 3 Fix A — final list generation with deterministic-first
 * partition. Takes the consolidated + gap-filled list and returns the
 * shopper-ready final list. Items meeting any of the AI-subset criteria in
 * {@link partitionForAI} go to Sonnet; everything else gets a final
 * displayName + flags computed locally.
 *
 * Contract:
 *   - When the AI subset is empty, the Sonnet call is skipped entirely.
 *   - Local no-add guard: throws GroceryListAIError if Sonnet returns more
 *     items than its (sub)input.
 *   - Global no-add guard: throws GroceryListAIError if the merged output
 *     count exceeds the original input count (defense-in-depth — the local
 *     guard plus the 1:1 deterministic outputs make this unreachable in
 *     practice, but the check is cheap).
 *   - Sonnet outputs are placed back at the original positions of their
 *     subset entries when count matches subset size; when Sonnet merges
 *     (rule 2), later outputs reuse the i-th subset slot's index so the
 *     final order is stable and original-input-positioned.
 *   - Preserves all three boolean flags exactly on the deterministic path
 *     (1:1 build) and per the prompt contract on the AI path.
 *   - Does NOT mutate input items.
 */
export async function generateFinalGroceryList(
  planTitle: string,
  items: ConsolidatedItem[],
  knownSections: StoreSection[],
  opts: GroceryListAIOptions,
): Promise<GenerateGroceryListResult> {
  const { deterministic, aiSubset } = partitionForAI(items);

  type Placed = { index: number; out: GenerateListOutputItem };
  const placed: Placed[] = deterministic.map(({ item, index }) => ({
    index,
    out: buildDeterministicOutputItem(item),
  }));

  // Skip Sonnet entirely when nothing needs AI work.
  if (aiSubset.length === 0) {
    placed.sort((a, b) => a.index - b.index);
    return { items: placed.map((p) => p.out) };
  }

  const aiItems = aiSubset.map((s) => s.item);
  const input: GenerateGroceryListInput = {
    planTitle,
    consolidated: aiItems.map((item) => ({
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
  if (result.data.items.length > aiSubset.length) {
    throw new GroceryListAIError(
      `AI returned ${result.data.items.length} items but AI subset had ${aiSubset.length}; item count must not increase.`,
    );
  }

  for (let i = 0; i < result.data.items.length; i++) {
    const out = result.data.items[i];
    // WS7-8b B2 — the AI subset carries the same-canonical/different-unit rows
    // the deterministic table couldn't merge (BUG-031 tail). Two fixes here:
    //   (1) Re-apply the ⅛ ladder to the AI-merged quantity. The AI merge (rule
    //       2) bypassed B1's sweep, letting off-ladder floats reach the user
    //       (the 3.97-oz root cause). The AI's merged total is final; this only
    //       snaps it to the ladder — it does NOT re-round pre-merge parts.
    //   (2) Compose the purchase pack onto the AI-path displayName, mirroring
    //       the deterministic path (buildDeterministicOutputItem → formatPackDisplay).
    //       Without this, AI-path items showed a bare name with no pack. Use the
    //       i-th subset item's purchase data (same canonical → representative).
    const src = aiSubset[i]?.item;
    placed.push({
      index: aiSubset[i].index,
      out: {
        ...out,
        quantity: roundNeedQuantity(out.quantity, out.unit),
        displayName: formatPackDisplay(
          out.displayName,
          src?.purchaseUnit ?? null,
          src?.purchaseDisplay ?? null,
        ),
      },
    });
  }

  // Global no-add guard — defense-in-depth. Deterministic outputs are 1:1
  // and the local guard caps AI output at aiSubset.length, so this is
  // unreachable in practice; cheap to keep honest.
  if (placed.length > items.length) {
    throw new GroceryListAIError(
      `Final list had ${placed.length} items but input had ${items.length}; item count must not increase.`,
    );
  }

  placed.sort((a, b) => a.index - b.index);
  return { items: placed.map((p) => p.out) };
}

// WS6 6c-6 Block B — single-item categorization fallback for the
// "Add an item" typeahead. Called by the lookup route only when the
// prefix scan against Ingredient.canonicalName + aliases returned zero
// hits. Cheap Haiku text+Zod call.
//
// The route layer wraps this single result into a LookupCandidate (with
// ingredientId: null) so the wire response shape stays unified with
// lookup hits.
export interface CategorizeGroceryItemOptions extends GroceryListAIOptions {
  // Test seam — production callers omit and the helper uses the module
  // runAICall import. Mirrors the prisma/userId DI pattern above.
  runAICall?: typeof productionRunAICall;
}

export async function categorizeGroceryItem(
  itemText: string,
  knownSections: StoreSection[] | undefined,
  nearMatches: string[] | undefined,
  opts: CategorizeGroceryItemOptions,
): Promise<ItemCategorizationResult> {
  // Validate input up-front so callers get a typed throw instead of a
  // wrapped AI-side validation error. Mirrors the runAICall pre-flight
  // checks in the other helpers.
  const input = ItemCategorizationInputSchema.parse({
    itemText,
    ...(knownSections !== undefined ? { knownSections: knownSections as SectionKey[] } : {}),
    ...(nearMatches !== undefined ? { nearMatches } : {}),
  });

  const runAICall = opts.runAICall ?? productionRunAICall;
  const result = await runAICall(
    "grocery.recurring_item_categorize",
    {
      itemText: input.itemText,
      knownSections: input.knownSections ?? null,
      nearMatches: input.nearMatches ?? null,
    },
    ItemCategorizationResultSchema,
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
