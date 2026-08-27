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
import { bucketKeyOf, type ConsolidatedItem } from "./groceryList";
import { normalizeIngredientName } from "./groceryNormalization";
import { baseStapleName } from "./groceryStaples";
import { logger } from "./logger";
import {
  convertToGrams,
  lookupConversion,
  normalizeUnit,
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
      // D-WS9-053 §2.0 — temp 0: the purchaseUnit/Quantity/Display this returns
      // is WRITTEN BACK into the shared Ingredient row (groceryListAI.ts write-
      // back) and reused by every future grocery calc, so a sampled draw would
      // persist noise into shared catalog data. A purchase size is a lookup, not
      // a creative output. (The global runAICall default stays 0.7 for prose.)
      temperature: 0,
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

// WS7-8b B2 commit 3 — the pack-display formatter (formatPackDisplay) moved to
// the CLIENT (kiwi/lib/format/grocery.ts). The pack is now persisted as data
// (purchaseUnit/purchaseQuantity/purchaseDisplay) and composed with the name +
// the need parenthetical at render, so nothing formatted is persisted.

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

// WS7-8b B2 commit 3 — resolve the persisted pack for an item, applying
// head↔clove scaling (BUG-025-1: need 30 cloves → "3 heads", not "1 head").
// Returns the pack as DATA; the client composes the two-part line at render.
function resolvePurchaseFields(item: ConsolidatedItem): {
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
} {
  const conv = resolveConversion(item.canonicalName, item.conversionRef);
  const scaled = scalePurchaseForSubUnit(conv, item.quantity, item.unit);
  if (scaled && conv?.subUnit) {
    return {
      purchaseUnit: conv.subUnit.parent,
      purchaseQuantity: scaled.purchaseQuantity,
      purchaseDisplay: scaled.purchaseDisplay,
    };
  }
  return {
    purchaseUnit: item.purchaseUnit,
    purchaseQuantity: item.purchaseQuantity,
    purchaseDisplay: item.purchaseDisplay,
  };
}

// BUG-142 — quantity conservation across an AI merge.
//
// A conserving comparison needs ONE common unit. Grams is the only basis the
// conversion table can express both a weight and a volume in, so the check runs
// there. Every quantity in the group must convert, or the group is not
// checkable and the merge is refused — never assumed sound.
//
// The conversion is resolved once for the whole group, exactly as
// groceryMerge.groupConversion does it (persisted conversionRef, then the code
// table, then the BASE STAPLE's code-table row), so the deterministic merge and
// this guard agree about what is convertible instead of disagreeing at the
// boundary.
function conversionForGroup(
  items: ConsolidatedItem[],
): ReturnType<typeof resolveConversion> {
  for (const it of items) {
    const c = resolveConversion(it.canonicalName, it.conversionRef);
    if (c) return c;
  }
  for (const it of items) {
    const norm = normalizeIngredientName(it.canonicalName);
    const base = baseStapleName(norm);
    if (base === norm) continue;
    const c = lookupConversion(base);
    if (c) return c;
  }
  return null;
}

// Sum (quantity, unit) pairs in grams. Returns null the moment any one of them
// is not convertible — a partial sum would silently compare unlike totals.
function totalGrams(
  parts: { quantity: number; unit: string }[],
  conv: ReturnType<typeof resolveConversion>,
): number | null {
  let g = 0;
  for (const p of parts) {
    const one = convertToGrams(p.quantity, p.unit, conv);
    if (one === null) return null;
    g += one;
  }
  return g;
}

// Relative tolerance for the conservation comparison. Generous enough to absorb
// float noise and a model writing 1/3 as 0.333, tight enough to catch both
// defects actually observed on the salt case: +28% (a merged total emitted
// ALONGSIDE the part it already contained) and -3.5% (a part silently shrunk
// from 1 tbsp to 0.875 tbsp). Anything looser than a ladder step is not worth
// refusing over; anything at or above this is a real shopping error.
const CONSERVATION_REL_TOLERANCE = 0.005;

function buildDeterministicOutputItem(
  item: ConsolidatedItem,
): GenerateListOutputItem {
  const pack = resolvePurchaseFields(item);
  return {
    // BUG-165 — a deterministic row stands for exactly its own bucket.
    sourceKeys: [bucketKeyOf(item.canonicalName, item.unit)],
    canonicalName: item.canonicalName,
    // Raw ingredient name — the pack is NO LONGER baked in (commit 3). The
    // client renders "{purchaseDisplay} {name} ({need})" as one line.
    displayName: item.displayName,
    quantity: item.quantity,
    unit: item.unit,
    sectionKey: item.sectionKey as SectionKey,
    isUniversalStaple: item.isUniversalStaple,
    isUserPantryStaple: item.isUserPantryStaple,
    isRecurringItem: item.isRecurringItem,
    notes: null,
    isAmbiguous: false,
    wasAiInferred: false,
    ...pack,
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
 *   - BUG-142 conservation guard: for any canonical the AI was handed more than
 *     one row of, the total quantity it returns must equal the total it was
 *     given, compared in grams. A group that does not conserve — or that cannot
 *     be expressed in a common unit — is shipped UNMERGED from the consolidated
 *     rows. The merge is refused, never repaired. (This REPLACED the former
 *     global count guard, which policed item count twice and quantity never.)
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

  // BUG-095 — match AI output back to source items by IDENTITY, not position.
  //
  // The prompt explicitly permits reordering ("The output order should follow
  // grocery-store flow when possible ... but a stable input order is also
  // acceptable") and permits merging two same-canonicalName inputs into one
  // output (rule 2). The only guard was a LENGTH comparison, so the old
  // `aiSubset[i]` zip attached the i-th source's purchase pack — and the i-th
  // source's final index — to whatever the model happened to put in slot i.
  // That is how `1 bunch eggs`, `1 dozen milk` and a bananas row wearing white
  // onion's pack reach a real user's list.
  //
  // canonicalName is the identity key: the prompt tells the model to refine
  // displayName, never canonicalName, and echoes it in every worked example.
  // Names are matched through normalizeIngredientName so a case or whitespace
  // wobble in the echo does not fail the match.
  //
  // Queue-per-name, consumed in original-index order. This is what defines the
  // three interesting cases:
  //   • REORDER — each output pops the one source carrying its name, wherever
  //     the model moved it to. Pack and index follow the source, not the slot.
  //   • MERGE (rule 2 — same canonicalName, different units) — both sources sit
  //     in the same queue, so the single merged output pops the FIRST of them:
  //     it inherits the LOWEST original index (the merged row lands where the
  //     earlier of its parts was) and that same source's pack basis. The two
  //     parts share a canonicalName, so they resolve the same conversion row
  //     and the pack is recomputed against the AI's merged quantity/unit
  //     anyway; picking the lowest index makes the outcome DEFINED rather than
  //     incidentally-correct. The un-popped sibling is simply dropped, which is
  //     what a merge means.
  //   • DUPLICATE canonicals that were NOT merged (BUG-096's singular/plural
  //     rows can produce these) — outputs pop in order, so the first output for
  //     a name takes the first source, the second takes the second. Same
  //     tie-break, one rule.
  //
  // FAIL CLOSED: an output whose name matches no unconsumed source gets NULL
  // pack fields and a leftover index — never a neighbour's pack. It is logged,
  // because a model that stops echoing canonicalName would otherwise silently
  // strip every pack from the list.
  // ── BUG-142 — QUANTITY CONSERVATION over the AI's cross-unit arithmetic ──
  //
  // Rule 3 of partitionForAI hands Sonnet every set of rows sharing a canonical
  // name but differing in unit, precisely BECAUSE the deterministic table could
  // not reconcile them, and asks it to do the conversion free-form. Nothing
  // downstream checked the arithmetic: the guards were both COUNTS, and a count
  // cannot tell 10.75 tsp from 13.75 tsp. Six generations over byte-identical
  // input produced 10.75 tsp (correct), 10.75 tsp + a surviving 1 tbsp (+28%,
  // a shopper buys a third more salt than the plan needs) and 7.75 tsp +
  // 0.875 tbsp (-3.5%). All three passed every guard that existed.
  //
  // So: for every canonical the AI was handed MORE THAN ONE row of — exactly
  // the rule-3 partner set, the only population where cross-unit arithmetic
  // happens — the total it gives back must equal the total it was given.
  //
  // FAILURE MODE IS REFUSAL, NEVER REPAIR. A group that does not conserve, or
  // that cannot be expressed in a common unit at all, is rebuilt from the
  // consolidated rows and shipped UNMERGED — the AI's merge for that canonical
  // is discarded whole. Two ugly rows beat a silent 28% over-order, and the
  // model's arithmetic is never trusted, corrected, or split the difference
  // with. Single-row canonicals are untouched: there is no sum to conserve, and
  // policing them would refuse the ordinary unit refinement the pass exists for.
  const entriesByName = new Map<string, PartitionedItem[]>();
  for (const entry of aiSubset) {
    const key = normalizeIngredientName(entry.item.canonicalName);
    const q = entriesByName.get(key);
    if (q) q.push(entry);
    else entriesByName.set(key, [entry]);
  }
  const outputIdxByName = new Map<string, number[]>();
  for (let i = 0; i < result.data.items.length; i++) {
    const key = normalizeIngredientName(result.data.items[i].canonicalName);
    const a = outputIdxByName.get(key);
    if (a) a.push(i);
    else outputIdxByName.set(key, [i]);
  }

  // Outputs are attributed to a group by their OWN canonicalName, not by which
  // entry they popped. A model that emits THREE salt rows for two inputs leaves
  // the third unmatched, and attributing by match would let that phantom row's
  // quantity escape the sum entirely — the over-order shape, undetected.
  const refusedNames = new Set<string>();
  for (const [name, entries] of entriesByName) {
    if (entries.length < 2) continue;
    const outIdx = outputIdxByName.get(name) ?? [];
    const inParts = entries.map((e) => ({
      quantity: e.item.quantity,
      unit: e.item.unit,
    }));
    const outParts = outIdx.map((i) => ({
      quantity: result.data.items[i].quantity,
      unit: result.data.items[i].unit,
    }));

    // Untouched passthrough — same rows back, same units, same quantities. No
    // arithmetic was done, so there is nothing to conserve and no conversion is
    // needed. Without this an un-convertible pair the model sensibly left alone
    // would be refused, discarding its section/name polish for no benefit.
    const shape = (p: { quantity: number; unit: string }[]) =>
      p
        .map((x) => `${x.quantity}|${normalizeUnit(x.unit)}`)
        .sort()
        .join(",");
    if (outParts.length === inParts.length && shape(outParts) === shape(inParts)) {
      continue;
    }

    const conv = conversionForGroup(entries.map((e) => e.item));
    const need = totalGrams(inParts, conv);
    const got = totalGrams(outParts, conv);
    if (
      need === null ||
      got === null ||
      !(need > 0) ||
      Math.abs(got - need) > need * CONSERVATION_REL_TOLERANCE
    ) {
      refusedNames.add(name);
      logger.warn(
        {
          event: "grocery_ai_merge_refused",
          userId: opts.userId,
          canonicalName: name,
          inputRows: inParts.length,
          outputRows: outParts.length,
          neededGrams: need,
          returnedGrams: got,
          reason:
            need === null || got === null
              ? "not_convertible_to_common_unit"
              : "quantity_not_conserved",
        },
        "grocery.generate_list merge did not conserve quantity; shipping the consolidated rows unmerged",
      );
    }
  }

  const isRefused = (out: GenerateListOutputItem) =>
    refusedNames.has(normalizeIngredientName(out.canonicalName));
  // Output slots that survive refusal. A refused group's AI rows are discarded
  // whole and replaced by deterministic rebuilds below.
  const survivingOut = result.data.items
    .map((_, i) => i)
    .filter((i) => !isRefused(result.data.items[i]));

  const queueByName = new Map<string, PartitionedItem[]>();
  for (const entry of aiSubset) {
    const key = normalizeIngredientName(entry.item.canonicalName);
    if (refusedNames.has(key)) continue; // rebuilt deterministically, not poppable
    const q = queueByName.get(key);
    if (q) q.push(entry);
    else queueByName.set(key, [entry]);
  }
  // Leftover index pool for unmatched outputs, ascending. Populated after the
  // matching pass so it only contains indices no matched row claimed.
  const claimed = new Set<number>();
  const matches = new Map<number, PartitionedItem | null>();
  for (const i of survivingOut) {
    const q = queueByName.get(
      normalizeIngredientName(result.data.items[i].canonicalName),
    );
    const entry = q && q.length > 0 ? q.shift()! : null;
    if (entry) claimed.add(entry.index);
    matches.set(i, entry ?? null);
  }

  // BUG-165 — every entry the matching pass did NOT pop was absorbed by a
  // merge. Its GroceryListItemSource rows are still owed: the plan really does
  // need that dish's salt, whichever row ends up carrying it. Hand its bucket
  // key to the first surviving output for the same canonical — the row the
  // merge collapsed into — so provenance follows the quantity instead of being
  // re-guessed at persist time from a (canonicalName, unit) join that can only
  // ever match one of the parts.
  //
  // This is STRUCTURAL, not detection: a sibling is either absorbed here with
  // its key carried, or its whole group was refused above and it is rebuilt
  // below as its own row with its own key. There is no third path, so there is
  // no path on which a still-needed source set is dropped.
  const absorbedKeys = new Map<number, string[]>();
  for (const [name, q] of queueByName) {
    if (q.length === 0) continue;
    const host = survivingOut.find(
      (i) => normalizeIngredientName(result.data.items[i].canonicalName) === name,
    );
    if (host === undefined) continue;
    const keys = absorbedKeys.get(host) ?? [];
    for (const e of q) {
      keys.push(bucketKeyOf(e.item.canonicalName, e.item.unit));
      claimed.add(e.index);
    }
    absorbedKeys.set(host, keys);
  }

  const leftoverIndices = aiSubset
    .map((e) => e.index)
    .filter((idx) => !claimed.has(idx))
    .filter(
      (idx) =>
        !refusedNames.has(
          normalizeIngredientName(
            aiSubset.find((e) => e.index === idx)!.item.canonicalName,
          ),
        ),
    )
    .sort((a, b) => a - b);
  const unmatchedNames = survivingOut
    .filter((i) => matches.get(i) === null)
    .map((i) => result.data.items[i].canonicalName);
  if (unmatchedNames.length > 0) {
    logger.warn(
      {
        event: "grocery_ai_output_unmatched",
        userId: opts.userId,
        unmatchedNames,
        unmatchedCount: unmatchedNames.length,
        aiOutputCount: result.data.items.length,
        aiSubsetCount: aiSubset.length,
      },
      "grocery.generate_list returned items whose canonicalName matched no input row; shipping them with a null purchase pack",
    );
  }

  for (const i of survivingOut) {
    const out = result.data.items[i];
    // WS7-8b B2 — the AI subset carries the same-canonical/different-unit rows
    // the deterministic table couldn't merge (BUG-031 tail). Two fixes here:
    //   (1) Re-apply the ⅛ ladder to the AI-merged quantity. The AI merge (rule
    //       2) bypassed B1's sweep, letting off-ladder floats reach the user
    //       (the 3.97-oz root cause). The AI's merged total is final; this only
    //       snaps it to the ladder — it does NOT re-round pre-merge parts.
    //   (2) Attach the purchase pack as DATA (commit 3), from the i-th subset
    //       item + head↔clove scaling against the AI's merged quantity. The
    //       client composes the two-part line; the pack is not baked into the
    //       name. displayName stays the AI's shopper-friendly name.
    // BUG-095 — identity match, not `aiSubset[i]`. Null src means the model
    // emitted a name no input row carried: null pack, leftover slot.
    const match = matches.get(i) ?? null;
    const src = match?.item;
    const pack = src
      ? resolvePurchaseFields({ ...src, quantity: out.quantity, unit: out.unit })
      : { purchaseUnit: null, purchaseQuantity: null, purchaseDisplay: null };
    placed.push({
      index: match ? match.index : (leftoverIndices.shift() ?? items.length + i),
      out: {
        ...out,
        quantity: roundNeedQuantity(out.quantity, out.unit),
        ...pack,
        // BUG-165 — the row's own bucket plus every sibling it absorbed. An
        // output that matched nothing represents no consolidated bucket and so
        // claims no provenance, rather than inheriting a neighbour's.
        sourceKeys: [
          ...(src ? [bucketKeyOf(src.canonicalName, src.unit)] : []),
          ...(absorbedKeys.get(i) ?? []),
        ],
      },
    });
  }

  // BUG-142 — rebuild every refused group from the consolidated rows. These go
  // back at their ORIGINAL indices carrying their original quantity, unit and
  // bucket key, so the list shows the un-merged parts and each part keeps its
  // own provenance. This is the refusal path in full: no AI row for these
  // canonicals survives, and nothing is silently corrected.
  for (const entry of aiSubset) {
    if (!refusedNames.has(normalizeIngredientName(entry.item.canonicalName))) {
      continue;
    }
    placed.push({
      index: entry.index,
      out: buildDeterministicOutputItem(entry.item),
    });
  }

  // BUG-142 — the global `placed.length > items.length` count guard was REMOVED
  // here; the conservation check above replaces it.
  //
  // It was a second guard on the SAME concern as the local no-add check (item
  // count must not increase), and its own comment conceded it was "unreachable
  // in practice". Two guards on one concern drift, and this pair drifted in the
  // worst direction: between them they policed COUNT twice and QUANTITY never,
  // which is exactly how a 13.75-tsp order for a 10.75-tsp need passed. A count
  // is not a conservation law — merging two rows into one and merging them into
  // one WRONG one produce identical counts.
  //
  // It is also now actively wrong: refusing a merge legitimately restores rows,
  // so a list that correctly declines to merge could trip a count ceiling and
  // fail the whole generation — the guard would turn a safe outcome into an
  // outage. The local no-add guard above still caps what the model may invent,
  // which is a genuinely different failure and stays.
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
