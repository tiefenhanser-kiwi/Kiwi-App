// [grocery] B2 · Part A2 — THE DRY RUN, THROUGH THE WHOLE PIPELINE. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/preview2.ts  -> out/preview2.txt
//
// ⚠️ WHY THIS REPLACES preview.ts. Part A's dry run ran consolidate + merge and
// stopped. Pack resolution (resolvePurchaseFields -> scalePurchaseForSubUnit)
// lives INSIDE generateFinalGroceryList, so the preview could not see a pack
// change at all: its BEFORE printed "1 head Garlic (25 cloves)" where B1's Part
// E printed "3 heads Garlic (25 cloves)". A dry run that cannot show a quantity
// regression is not a dry run. This one runs the census harness's own stages:
//
//   loadRelationIndex -> consolidatePlanIngredients -> fillPurchaseSizesWithWriteBack
//     -> generateFinalGroceryList -> the CLIENT's composePackName / renderedPack
//
// Sonnet is stubbed with the census's echo (mode "det") so both passes are
// deterministic. Every Ingredient write is intercepted and applied to nothing.

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient, type StoreSection } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import {
  consolidatePlanIngredients,
  type ConsolidatedItem,
} from "../../src/lib/groceryList";
import {
  fillPurchaseSizesWithWriteBack,
  generateFinalGroceryList,
  partitionForAI,
} from "../../src/lib/groceryListAI";
import type { GenerateListOutputItem } from "../../src/lib/ai/schemas/grocery";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { instacartSearchName } from "../../src/lib/retailers/instacartName";
import {
  rowConversion,
  convertToGrams,
  convertWithinDimension,
  canonicalUnitToken,
  isCountUnit,
} from "../../src/lib/ingredientConversions";
import type { RelationRow as RelRow } from "../../src/lib/ingredientRelations";

import {
  buildPlanIndex,
  riderText,
  leadingCount,
  atLeastUsesMeasure,
  shadowDisplayName,
  containmentVerdict,
  packResidue,
  type SubsumesEdge,
} from "./shadow";
import { classifyEdge, DEFAULTS, RULED_DEFAULTS, H1_TOKENS, distinguishingTokens, NAME_CLEANINGS } from "./proposals";

// ── the client's render, loaded the way census.ts loads it ──────────────────
import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";
interface GroceryFormat {
  composePackName: (
    name: string, purchaseUnit?: string | null, purchaseDisplay?: string | null,
    needAmount?: string | number | null, needUnit?: string | null, isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (a: string | undefined, u: string | undefined, f: string) => string;
  renderedPack: (
    purchaseDisplay?: string | null, needAmount?: string | null, needUnit?: string | null,
    purchaseUnit?: string | null, isPantryStaple?: boolean,
  ) => { packCount: number; packSizeText: string | null } | null;
}
const ns = groceryFormatNs as unknown as { default?: Partial<GroceryFormat> } & Partial<GroceryFormat>;
const G = (ns.composePackName ? ns : ns.default) as GroceryFormat | undefined;
if (typeof G?.composePackName !== "function") throw new Error("client render not loadable");
const { composePackName, formatNeedText, renderedPack } = G;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const PLANS = [
  "f5556c19", "56b03a57", "c404a3cf", "247cd7bb", "14879176", "b8e7f134",
  "31c7a885", "96a94410", "425da049", "ed238692", "2b6e51a1", "6e952e32",
  "a8b0bbd5", "316d0846", "11653a33", "353ce059", "14397131", "163875ec",
  "d47d18aa", "8a462408",
];
const KNOWN_SECTIONS: StoreSection[] = [
  "produce", "meat_seafood", "dairy_eggs", "pantry", "bakery_bread",
  "canned", "frozen", "snacks", "household", "extras",
];

// ── the fences, copied from census.ts because they are the point ───────────
const INGREDIENT_WRITE_OPS = new Set([
  "update", "updateMany", "upsert", "create", "createMany", "delete", "deleteMany",
]);
interface InterceptedWrite { table: string; op: string; where: unknown; data: unknown }

function interceptingPrisma(base: PrismaClient, sink: InterceptedWrite[]): PrismaClient {
  const realIngredient = (base as unknown as Record<string, Record<string, unknown>>)["ingredient"];
  const ingredientProxy = new Proxy(realIngredient, {
    get(target, prop: string) {
      if (INGREDIENT_WRITE_OPS.has(prop)) {
        return async (args: { where?: unknown; data?: unknown }) => {
          sink.push({ table: "Ingredient", op: prop, where: args?.where ?? null, data: args?.data ?? null });
          return { __intercepted: true };
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(base, {
    get(target, prop: string, recv) {
      if (prop === "ingredient") return ingredientProxy;
      if (prop === "$transaction") {
        const real = Reflect.get(target, prop, recv) as (...a: unknown[]) => unknown;
        return (first: unknown, ...rest: unknown[]) =>
          Array.isArray(first) ? Promise.all(first as Promise<unknown>[]) : real.call(target, first, ...rest);
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as PrismaClient;
}

/**
 * The Sonnet echo, plus a HAIKU CACHE.
 *
 * ⚠️ The gap-fill is cached across the two passes ON PURPOSE. It calls Haiku for
 * real, and Haiku is not deterministic; letting it run twice would put invented
 * pack differences into the BEFORE/AFTER diff and none of them would be this
 * block's doing. One call per canonical, both passes read the same answer.
 */
const haikuCache = new Map<string, Anthropic.Message>();
let haikuCalls = 0;

function stubClient(aiSubset: ConsolidatedItem[]): Pick<Anthropic, "messages"> {
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        if (!String(params.model).includes("sonnet")) {
          const key = createHash("sha256").update(JSON.stringify(params)).digest("hex");
          const hit = haikuCache.get(key);
          if (hit) return hit;
          const { default: Real } = await import("@anthropic-ai/sdk");
          const real = new Real({ apiKey: process.env.ANTHROPIC_API_KEY! });
          const res = (await real.messages.create(params)) as Anthropic.Message;
          haikuCalls++;
          haikuCache.set(key, res);
          return res;
        }
        const items = aiSubset.map((it) => ({
          canonicalName: it.canonicalName,
          displayName: it.displayName,
          quantity: it.quantity > 0 ? it.quantity : 0.0001,
          unit: it.unit,
          sectionKey: it.sectionKey,
          isUniversalStaple: it.isUniversalStaple,
          isUserPantryStaple: it.isUserPantryStaple,
          isRecurringItem: it.isRecurringItem,
          notes: null, isAmbiguous: false, wasAiInferred: false,
        }));
        return {
          id: "echo", type: "message", role: "assistant", model: String(params.model),
          content: [{ type: "text", text: JSON.stringify({ items }) }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
}

// ── the render, byte-for-byte the census's renderRow ───────────────────────
function renderRow(it: GenerateListOutputItem, rider: string | null, containment: boolean): {
  packName: string; needText: string; line: string; packCount: number | null;
} {
  const quantityAmount = String(it.quantity);
  const quantityUnit = it.unit || undefined;
  const staple = it.isUniversalStaple || it.isUserPantryStaple;
  const needText = formatNeedText(
    quantityAmount, quantityUnit,
    quantityUnit ? `${it.quantity} ${it.unit}` : String(it.quantity),
  ).trim();
  let packName = composePackName(
    it.displayName, it.purchaseUnit ?? undefined, it.purchaseDisplay ?? undefined,
    quantityAmount, quantityUnit, staple,
  );
  if (containment && it.purchaseDisplay) {
    const nm = it.displayName.trim();
    const tail = ` ${nm.toLowerCase()}`;
    if (packName.toLowerCase().endsWith(tail)) {
      const packLine = packName.slice(0, packName.length - nm.length).trim();
      if (!/^~?\d+(?:[./]\d+)?$/.test(packLine)) {
        const v = containmentVerdict(packResidue(packLine), nm);
        if (v.kind === "drop-name") packName = packLine;
        else if (v.kind === "name-absorbs") {
          const count = packLine.match(/^~?\d+(?:[./]\d+)?/)?.[0] ?? "";
          packName = count ? `${count} ${nm}` : nm;
        }
      }
    }
  }
  const withRider = rider ? `${packName}, ${rider}` : packName;
  const rp = renderedPack(
    it.purchaseDisplay ?? undefined, quantityAmount, quantityUnit,
    it.purchaseUnit ?? undefined, staple,
  );
  return {
    packName: withRider,
    needText,
    line: needText ? `${withRider} (${needText})` : withRider,
    packCount: rp?.packCount ?? null,
  };
}

// ── GATE 1 — packs x pack size >= the need, in the need's dimension ────────
type GateVerdict = { ok: boolean; detail: string } | { ok: null; detail: string };

function gate1(it: GenerateListOutputItem, packCount: number | null): GateVerdict {
  const need = it.quantity;
  if (!(need > 0)) return { ok: true, detail: "no need" };
  const conv = rowConversion({
    canonicalName: it.canonicalName,
    conversionRef: (it as unknown as { conversionRef?: unknown }).conversionRef ?? null,
    packYieldUnit: (it as unknown as { packYieldUnit?: string | null }).packYieldUnit ?? null,
    packYieldPerPack: (it as unknown as { packYieldPerPack?: number | null }).packYieldPerPack ?? null,
  } as never);
  const packs = packCount ?? it.purchaseQuantity ?? null;
  if (packs === null || !(packs > 0)) return { ok: null, detail: "no pack count" };

  // Case A — the pack is stated in the need's own unit family.
  if (it.purchaseUnit) {
    const same = convertWithinDimension(packs * (it.purchaseQuantity ?? 1), it.purchaseUnit, it.unit);
    if (same !== null) {
      return { ok: same + 1e-9 >= need, detail: `${same.toFixed(3)} ${it.unit} bought vs ${need} needed` };
    }
  }
  // Case B — a pack yield names how much of the need ONE pack gives.
  const py = (it as unknown as { packYieldPerPack?: number | null }).packYieldPerPack;
  const pu = (it as unknown as { packYieldUnit?: string | null }).packYieldUnit;
  if (py && pu) {
    const bought = packs * py;
    const same = canonicalUnitToken(pu) === canonicalUnitToken(it.unit)
      ? bought : convertWithinDimension(bought, pu, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, detail: `${same.toFixed(3)} ${it.unit} via pack yield vs ${need}` };
  }
  // Case C — both sides are bare counts.
  if (it.purchaseUnit && isCountUnit(it.purchaseUnit) && isCountUnit(it.unit)) {
    const bought = packs * (it.purchaseQuantity ?? 1);
    return { ok: bought + 1e-9 >= need, detail: `${bought} vs ${need} (counts)` };
  }
  // Case D — grams, if the conversion can express both.
  if (conv && it.purchaseUnit) {
    const boughtG = convertToGrams(packs * (it.purchaseQuantity ?? 1), it.purchaseUnit, conv);
    const needG = convertToGrams(need, it.unit, conv);
    if (boughtG !== null && needG !== null) {
      return { ok: boughtG + 1e-6 >= needG, detail: `${boughtG.toFixed(1)} g vs ${needG.toFixed(1)} g` };
    }
  }
  return { ok: null, detail: `unrelatable: pack ${packs} x ${it.purchaseQuantity ?? "?"} ${it.purchaseUnit ?? "?"} vs need ${need} ${it.unit}` };
}

// ── GATE 3 — no line mixes varieties H1 keeps apart ────────────────────────
function gate3(line: string, membersFolded: string[]): string | null {
  if (membersFolded.length < 2) return null;
  for (let i = 0; i < membersFolded.length; i++) {
    for (let j = i + 1; j < membersFolded.length; j++) {
      const a = membersFolded[i];
      const b = membersFolded[j];
      const ab = classifyEdge(a, b).hClass;
      const ba = classifyEdge(b, a).hClass;
      if (ab === "H1" && ba === "H1") {
        // Both directions say different product AND neither is the other's
        // generic — only a real H1 pair trips this.
        const extraA = distinguishingTokens(b, a).filter((t) => H1_TOKENS.has(t));
        const extraB = distinguishingTokens(a, b).filter((t) => H1_TOKENS.has(t));
        if (extraA.length > 0 && extraB.length > 0) {
          return `"${line}" folds ${a} with ${b} — H1 keeps them apart`;
        }
      }
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────────────────────────────

const relations = await loadRelationIndex(prisma);

// the real relation rows, as relationIndexLoader reads them
const relRows = await prisma.ingredientRelation.findMany({
  select: {
    label: true, yieldQuantity: true, yieldUnit: true, coHarvestable: true,
    confidence: true, reviewedByHuman: true,
    from: { select: { canonicalName: true, defaultUnit: true, purchaseUnit: true } },
    to: { select: { canonicalName: true } },
  },
});
const realRows: RelRow[] = relRows.map((r) => ({
  label: r.label as RelRow["label"],
  fromCanonicalName: r.from.canonicalName,
  toCanonicalName: r.to.canonicalName,
  yieldQuantity: r.yieldQuantity,
  yieldUnit: r.yieldUnit,
  coHarvestable: r.coHarvestable,
  confidence: r.confidence as RelRow["confidence"],
  reviewedByHuman: r.reviewedByHuman,
  fromDefaultUnit: r.from.defaultUnit,
  fromPurchaseUnit: r.from.purchaseUnit,
}));

const usedIds = new Set(
  (await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId),
);
const liveEdges: SubsumesEdge[] = (
  await prisma.ingredientRelation.findMany({
    where: { label: "subsumes" },
    select: {
      fromIngredientId: true, toIngredientId: true, confidence: true, reviewedByHuman: true,
      from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } },
    },
  })
)
  .filter((r) => usedIds.has(r.fromIngredientId) && usedIds.has(r.toIngredientId))
  .filter((r) => r.reviewedByHuman || r.confidence === "high")
  .map((r) => ({ generic: r.from.canonicalName, specific: r.to.canonicalName }));

const catalog = await prisma.ingredient.findMany({
  select: { canonicalName: true, displayName: true, purchaseUnit: true },
});
const packUnitOf = new Map(catalog.map((i) => [i.canonicalName, i.purchaseUnit]));
const catalogName = new Map(
  catalog.map((i) => [i.canonicalName, shadowDisplayName(i.canonicalName, i.displayName, true)]),
);

const resolved = await prisma.mealPlanInstance.findMany({
  where: { OR: PLANS.map((p: string) => ({ id: { startsWith: p } })) },
  select: { id: true, userId: true, titleOverride: true, template: { select: { title: true } } },
});

const L: string[] = [];
L.push("[grocery] B2 — THE DRY RUN, Part A2 · September 28, 2026");
L.push("BEFORE = the real pipeline at HEAD: consolidate -> gap-fill -> final -> the");
L.push("         client's composePackName. Sonnet echoed; Haiku cached across passes.");
L.push("AFTER  = the same pipeline with the H1-H7 fold index, the proposed names and");
L.push("         the containment rule.");
L.push("");

let totalBefore = 0, changed = 0, identical = 0;
let recurringRows = 0, recurringChanged = 0;
let g1Fail = 0, g1FailPre = 0, g1Unverifiable = 0, g1UnverifiableNew = 0, g2Fail = 0, g3Fail = 0;
const gateNotes: string[] = [];
const allDecisions: string[] = [];
const allRefusals: string[] = [];
const interceptAll: InterceptedWrite[] = [];
const namedCases = new Map<string, string[]>();
const classOf = new Map<string, number>();
const NAME_CLEANED = new Set(NAME_CLEANINGS.filter((c) => c.current !== c.line).map((c) => c.current));

function note(plan: string, key: string, line: string) {
  const k = `${key}`;
  let a = namedCases.get(k);
  if (!a) { a = []; namedCases.set(k, a); }
  a.push(`[${plan}] ${line}`);
}

for (const short of PLANS) {
  const plan = resolved.find((p) => p.id.startsWith(short));
  if (!plan) { L.push(`## ${short} — NOT FOUND`); continue; }
  const title = plan.titleOverride ?? plan.template?.title ?? "";
  const db = interceptingPrisma(prisma, interceptAll);

  // ── BEFORE ──────────────────────────────────────────────────────────────
  const consB = await consolidatePlanIngredients({ prisma, planId: plan.id, userId: plan.userId, relations });
  const { aiSubset: subB } = partitionForAI(consB, relations);
  const optsB = { prisma: db, userId: undefined as unknown as string, client: stubClient(subB.map((s) => s.item)), relations };
  const filledB = await fillPurchaseSizesWithWriteBack(consB, optsB);
  const finalB = (await generateFinalGroceryList(title, filledB, KNOWN_SECTIONS, optsB)).items;
  const renderedB = finalB.map((it) => renderRow(it, null, false));

  // the share table: each variety's OWN pack count when it stands alone
  const shareOf = new Map<string, number>();
  finalB.forEach((it, i) => {
    const c = leadingCount(renderedB[i].packName) ?? renderedB[i].packCount ?? it.purchaseQuantity ?? 1;
    shareOf.set(normalizeIngredientName(it.canonicalName), c);
  });

  const demanded = new Set(consB.map((r) => normalizeIngredientName(r.canonicalName)));

  // ── AFTER, with a bounded collapse loop ────────────────────────────────
  const suppressH3 = new Set<string>();
  let planIdx = buildPlanIndex({ realRows, liveEdges, demanded, packUnitOf, suppressH3 });
  let finalA: GenerateListOutputItem[] = [];
  let renderedA: ReturnType<typeof renderRow>[] = [];
  let ridersUsed = new Map<string, string>();
  let foldedMembers = new Map<string, string[]>();

  for (let attempt = 0; attempt < 3; attempt++) {
    const consA0 = await consolidatePlanIngredients({
      prisma, planId: plan.id, userId: plan.userId, relations: planIdx.index,
    });
    // names: R7 + casing, catalog rows only; and the folded line takes the
    // PINNED name (the default under H2, the generic under H3).
    const consA: ConsolidatedItem[] = consA0.map((r) => {
      const key = planIdx.index.groupKey(r.canonicalName);
      // ⚠️ ONLY where THIS block moved the row. Comparing the key to the row's
      // own name instead catches every synonym fold that already worked at HEAD
      // — `fresh cilantro` -> `cilantro`, `fresh parsley` -> `parsley` — and
      // renames 155 lines nothing in H1-H7 is about.
      const pinnedName = key !== relations.groupKey(r.canonicalName) ? catalogName.get(key) : undefined;
      return {
        ...r,
        displayName: pinnedName ?? shadowDisplayName(r.canonicalName, r.displayName, r.ingredientId != null),
      };
    });
    const { aiSubset: subA } = partitionForAI(consA, relations);
    const optsA = { prisma: db, userId: undefined as unknown as string, client: stubClient(subA.map((s) => s.item)), relations };
    const filledA = await fillPurchaseSizesWithWriteBack(consA, optsA);
    finalA = (await generateFinalGroceryList(title, filledA, KNOWN_SECTIONS, optsA)).items;

    // which pre-fold names landed on each line?
    foldedMembers = new Map();
    for (const r of consB) {
      const key = planIdx.index.groupKey(r.canonicalName);
      let a = foldedMembers.get(key);
      if (!a) { a = []; foldedMembers.set(key, a); }
      const n = normalizeIngredientName(r.canonicalName);
      if (!a.includes(n)) a.push(n);
    }

    // riders, and the COLLAPSE check
    ridersUsed = new Map();
    const collapse: string[] = [];
    let needRerun = false;
    for (const it of finalA) {
      const key = planIdx.index.groupKey(it.canonicalName);
      const varieties = planIdx.ridersByKey.get(key);
      if (!varieties || varieties.length === 0) continue;
      const present = varieties.filter((v) => demanded.has(v));
      if (present.length === 0) continue;
      const rendered0 = renderRow(it, null, false);
      const total = leadingCount(rendered0.packName) ?? rendered0.packCount ?? it.purchaseQuantity ?? 1;
      const shares = present.map((v) => Math.max(1, Math.ceil(shareOf.get(v) ?? 1)));
      const sum = shares.reduce((a, b) => a + b, 0);
      if (sum >= total || total <= 1) {
        // "no whatever left to choose"
        if (present.length === 1) {
          collapse.push(`${key}: the line takes "${present[0]}" (share ${shares[0]} covers the whole count ${total})`);
          ridersUsed.set(key, `__RENAME__${present[0]}`);
        } else {
          collapse.push(`${key}: shares ${shares.join("+")} cover the whole count ${total} and there are ${present.length} varieties — nothing generic is left, so H1 stands`);
          suppressH3.add(key);
          needRerun = true;
        }
        continue;
      }
      ridersUsed.set(key, present.map((v, i) => riderText(key, v, shares[i])).join(" and "));
    }
    allDecisions.push(...collapse.map((c) => `[${short}] ${c}`));
    if (!needRerun) break;
    planIdx = buildPlanIndex({ realRows, liveEdges, demanded, packUnitOf, suppressH3 });
  }

  renderedA = finalA.map((it) => {
    const key = planIdx.index.groupKey(it.canonicalName);
    const r = ridersUsed.get(key);
    if (r?.startsWith("__RENAME__")) {
      const v = r.slice("__RENAME__".length);
      return renderRow({ ...it, displayName: catalogName.get(v) ?? v }, null, true);
    }
    return renderRow(it, r ?? null, true);
  });

  allDecisions.push(...planIdx.decisions.map((d) => `[${short}] ${d.rule}: ${d.members.join(", ")} -> ${d.target}   (${d.why})`));
  allRefusals.push(...planIdx.h3Refusals.map((x) => `[${short}] H3: ${x}`));
  allRefusals.push(...planIdx.h5Refusals.map((x) => `[${short}] H5: ${x}`));

  // ── the gates ───────────────────────────────────────────────────────────
  const beforeGate1 = new Map<string, GateVerdict>();
  finalB.forEach((it, i) => beforeGate1.set(normalizeIngredientName(it.canonicalName), gate1(it, renderedB[i].packCount)));

  const beforeSet = new Set(renderedB.map((r) => r.line));
  const afterSet = new Set(renderedA.map((r) => r.line));
  const planChanges: string[] = [];

  totalBefore += finalB.length;
  for (const r of consB) if (r.isRecurringItem) recurringRows++;
  const recB = renderedB.filter((_, i) => finalB[i].isRecurringItem).map((r) => r.line).sort();
  const recA = renderedA.filter((_, i) => finalA[i].isRecurringItem).map((r) => r.line).sort();
  for (let i = 0; i < Math.max(recB.length, recA.length); i++) if (recB[i] !== recA[i]) recurringChanged++;

  const afterLower = new Set(renderedA.map((r) => r.line.toLowerCase()));
  for (let i = 0; i < renderedB.length; i++) {
    if (afterSet.has(renderedB[i].line)) { identical++; continue; }
    changed++;
    // WHICH CLASS moved this row? Checked in the order the classes apply, so a
    // row that both folds and re-cases is counted once, under the fold.
    const b4 = finalB[i];
    const nm = normalizeIngredientName(b4.canonicalName);
    // ⚠️ "moved" is measured against the index PRODUCTION BUILDS TODAY, not
    // against the row's own name. Asking the second question counts every
    // pre-existing synonym fold — `fresh cilantro` -> `cilantro` has folded
    // since A2 — as though this block had done it, and it put 162 rows in the
    // fold class that this block never touched.
    const moved = planIdx.index.groupKey(b4.canonicalName) !== relations.groupKey(b4.canonicalName);
    const renamed = NAME_CLEANED.has(nm);
    const klass = moved ? "S · fold (H2/H3/GENERIC)"
      : renamed ? "N · buy-name"
      : afterLower.has(renderedB[i].line.toLowerCase()) ? "C · casing"
      : "R · residue / other";
    classOf.set(klass, (classOf.get(klass) ?? 0) + 1);
    planChanges.push(`     - [${klass}] ${renderedB[i].line}`);
  }
  for (let i = 0; i < renderedA.length; i++) {
    if (beforeSet.has(renderedA[i].line)) continue;
    planChanges.push(`     + ${renderedA[i].line}`);
    // gates run on CHANGED rows
    const it = finalA[i];
    const key = normalizeIngredientName(it.canonicalName);
    const v = gate1(it, renderedA[i].packCount);
    if (v.ok === false) {
      // NEW vs PRE-EXISTING. The gate exists to catch an under-order THIS block
      // introduces. A row whose BEFORE already under-ordered is a finding to
      // report, not a reason to refuse the block — and the go-ahead draws that
      // line explicitly for the unverifiable case, so it draws it here too.
      const had = beforeGate1.get(key);
      if (had && had.ok === false) {
        g1FailPre++;
        gateNotes.push(`  GATE1 fail, PRE-EXISTING [${short}] ${renderedA[i].line} — ${v.detail} (BEFORE: ${had.detail})`);
      } else {
        g1Fail++;
        gateNotes.push(`  GATE1 FAIL (new) [${short}] ${renderedA[i].line} — ${v.detail}`);
      }
    }
    else if (v.ok === null) {
      g1Unverifiable++;
      const had = beforeGate1.get(key);
      if (!had || had.ok !== null) { g1UnverifiableNew++; gateNotes.push(`  GATE1 UNVERIFIABLE (new) [${short}] ${renderedA[i].line} — ${v.detail}`); }
    }
    if (atLeastUsesMeasure(renderedA[i].line)) { g2Fail++; gateNotes.push(`  GATE2 FAIL [${short}] ${renderedA[i].line}`); }
    const g3 = gate3(renderedA[i].line, foldedMembers.get(planIdx.index.groupKey(it.canonicalName)) ?? []);
    if (g3) { g3Fail++; gateNotes.push(`  GATE3 FAIL [${short}] ${g3}`); }
  }

  if (planChanges.length > 0) {
    L.push(`## ${short}  (${finalB.length} -> ${finalA.length} rows)`);
    L.push(...planChanges);
    L.push("");
  }

  // ── the named cases ─────────────────────────────────────────────────────
  for (let i = 0; i < renderedA.length; i++) {
    const n = normalizeIngredientName(finalA[i].canonicalName);
    const line = renderedA[i].line;
    if (/onion/.test(n)) note(short, "onions", line);
    if (/chicken thigh/.test(n)) note(short, "chicken thighs", line);
    if (/bell pepper/.test(n)) note(short, "bell peppers", line);
    if (/parsley/.test(n)) note(short, "parsley", line);
    if (/cheddar/.test(n)) note(short, "cheddar", line);
    if (/marzano|crushed tomato/.test(n)) note(short, "san marzano", line);
    if (/garlic/.test(n)) note(short, "garlic (the B1 regression check)", line);
  }
  for (let i = 0; i < renderedB.length; i++) {
    const n = normalizeIngredientName(finalB[i].canonicalName);
    if (/garlic/.test(n)) note(short, "garlic BEFORE", renderedB[i].line);
    if (/bell pepper/.test(n)) note(short, "bell peppers BEFORE", renderedB[i].line);
  }
}

L.push("=".repeat(78));
L.push(`rows at BEFORE, across the ${PLANS.length} lists   ${totalBefore}`);
L.push(`byte-identical BEFORE -> AFTER        ${identical}`);
L.push(`changed                               ${changed}`);
for (const [k, v] of [...classOf].sort((a, b) => b[1] - a[1])) L.push(`     ${k.padEnd(28)} ${v}`);
L.push(`recurring synthetics in the corpus    ${recurringRows}`);
L.push(`recurring synthetics that changed     ${recurringChanged}   (must be 0)`);
L.push(`Ingredient writes attempted           ${interceptAll.length}   (all intercepted, none applied)`);
L.push(`Haiku gap-fill calls (cached)         ${haikuCalls}`);
L.push("");
L.push("GATES");
L.push(`  Gate 1 — packs x size >= need      FAIL(new) ${g1Fail} · fail(pre-existing) ${g1FailPre} · unverifiable ${g1Unverifiable} (new ${g1UnverifiableNew})`);
L.push(`  Gate 2 — "at least" + a measure     FAIL ${g2Fail}`);
L.push(`  Gate 3 — a line mixes H1 varieties  FAIL ${g3Fail}`);
L.push(`  VERDICT: ${g1Fail === 0 && g2Fail === 0 && g3Fail === 0 && g1UnverifiableNew === 0 ? "PASS" : "FAIL"}`);
for (const n of gateNotes.slice(0, 120)) L.push(n);
L.push("");
L.push("FOLD DECISIONS");
for (const d of [...new Set(allDecisions)].sort()) L.push(`  ${d}`);
L.push("");
L.push("FOLDS REFUSED");
for (const r of [...new Set(allRefusals)].sort()) L.push(`  ${r}`);
L.push("");
L.push("NAMED CASES");
for (const [k, v] of [...namedCases].sort()) {
  L.push(`  -- ${k} --`);
  for (const line of [...new Set(v)]) L.push(`     ${line}`);
}
L.push("");
L.push("H7 — THE RETAILER HAND-OFF");
L.push("  A search term keeps every word that makes a different product; only size,");
L.push("  prep and hedge words are stripped. instacartSearchName already does this:");
for (const nm of [
  "bone-in chicken thighs", "boneless skinless chicken thighs",
  "flour tortillas (large, 10-inch)", "long-grain white rice (day-old, cooked)",
  "red bell peppers", "vegetable oil",
]) {
  L.push(`     "${nm}"  ->  name "${instacartSearchName(nm)}"`);
}
L.push("  An H3 line is SENT AS SEPARATE ITEMS; the display line stays one line:");
L.push(`     display_text "5 bell peppers, at least 2 red and at least 2 yellow"`);
L.push(`     items        {name "red bell peppers", qty 2} · {name "yellow bell peppers", qty 2} · {name "bell peppers", qty 1}`);

writeFileSync(join(OUT, "preview2.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
console.log(`\n-> ${join(OUT, "preview2.txt")}`);
await prisma.$disconnect();
