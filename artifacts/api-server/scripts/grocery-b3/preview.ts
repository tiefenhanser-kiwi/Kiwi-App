// [grocery] B3 · Part A — THE DRY RUN, THROUGH THE WHOLE PIPELINE. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/preview.ts -> out/preview.txt
//
// Built on B2's preview2.ts, for the reason its header gives: pack resolution
// (resolvePurchaseFields -> scalePurchaseForSubUnit) lives INSIDE
// generateFinalGroceryList, so a preview that stops at consolidate cannot show a
// pack change at all. This runs the census harness's own stages:
//
//   loadRelationIndex -> consolidatePlanIngredients -> [the B3 shadow]
//     -> fillPurchaseSizesWithWriteBack -> generateFinalGroceryList
//     -> the CLIENT's composePackName / renderedPack
//
// Sonnet is stubbed with the census's echo so both passes are deterministic.
// Haiku runs for real and is CACHED across the two passes (B2's lesson: letting
// it run twice puts invented pack differences into the diff). Every Ingredient
// write is intercepted and applied to nothing.

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
import { lookupIngredientByName } from "../../src/lib/ingredientLookup";
import {
  rowConversion,
  convertToGrams,
  convertWithinDimension,
  canonicalUnitToken,
  isCountUnit,
} from "../../src/lib/ingredientConversions";
import { classifyEdge, H1_TOKENS, distinguishingTokens } from "../grocery-b2/proposals";
import {
  applyRecurringResolution,
  isTodaysSynthetic,
  r3Annotation,
  type CatalogRow,
  type R3Fields,
  type ResolveResult,
} from "./shadow";

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

const haikuCache = new Map<string, Anthropic.Message>();
let haikuCalls = 0;
let haikuHits = 0;

function stubClient(aiSubset: ConsolidatedItem[]): Pick<Anthropic, "messages"> {
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        if (!String(params.model).includes("sonnet")) {
          const key = createHash("sha256").update(JSON.stringify(params)).digest("hex");
          const hit = haikuCache.get(key);
          if (hit) { haikuHits++; return hit; }
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

// ── the render, byte-for-byte the census's renderRow, plus R3's annotation ──
function renderRow(it: GenerateListOutputItem, r3: R3Fields | undefined): {
  packName: string; needText: string; line: string; packCount: number | null;
} {
  const quantityAmount = String(it.quantity);
  const quantityUnit = it.unit || undefined;
  const staple = it.isUniversalStaple || it.isUserPantryStaple;
  const needText = formatNeedText(
    quantityAmount, quantityUnit,
    quantityUnit ? `${it.quantity} ${it.unit}` : String(it.quantity),
  ).trim();
  const packName = composePackName(
    it.displayName, it.purchaseUnit ?? undefined, it.purchaseDisplay ?? undefined,
    quantityAmount, quantityUnit, staple,
  );
  const rp = renderedPack(
    it.purchaseDisplay ?? undefined, quantityAmount, quantityUnit,
    it.purchaseUnit ?? undefined, staple,
  );
  // BLOCK C composes this suffix from the R3 fields; the dry run shows what it
  // will read. Nothing here is persisted or on the wire yet.
  const ann = r3 ? ` — ${r3Annotation(r3, it.displayName)}` : it.isRecurringItem ? " — recurring" : "";
  const base = needText ? `${packName} (${needText})` : packName;
  return { packName, needText, line: base + ann, packCount: rp?.packCount ?? null };
}

// ── GATE 1 — packs x pack size >= the need, in the need's dimension ────────
//
// ⚠️ THE CONVERSION DATA HAS TO BE PUT BACK ON THE ROW FIRST, and B2's preview2
// did not do it. `GenerateListOutputItem` carries no `conversionRef` and no pack
// yield — `generateFinalGroceryList` builds it from the pack fields alone — so
// preview2's three casts at its gate1 read `undefined` on EVERY row, Cases B and
// D could never fire, and the gate fell through to "unrelatable" for anything
// whose pack unit was not directly convertible to the need unit. Replayed over
// the b2 after-state corpus that predicate calls 803 of 1,041 rows unverifiable,
// not the 241 preview2.txt reports. `attachConv` below re-attaches the data from
// the consolidated row the output came from, which is the only thing that makes
// Cases B and D reachable.
type GateVerdict = { ok: boolean | null; detail: string };

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
  if (it.purchaseUnit) {
    const same = convertWithinDimension(packs * (it.purchaseQuantity ?? 1), it.purchaseUnit, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, detail: `${same.toFixed(3)} ${it.unit} bought vs ${need} needed` };
  }
  const py = (it as unknown as { packYieldPerPack?: number | null }).packYieldPerPack;
  const pu = (it as unknown as { packYieldUnit?: string | null }).packYieldUnit;
  if (py && pu) {
    const bought = packs * py;
    const same = canonicalUnitToken(pu) === canonicalUnitToken(it.unit) ? bought : convertWithinDimension(bought, pu, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, detail: `${same.toFixed(3)} ${it.unit} via pack yield vs ${need}` };
  }
  if (it.purchaseUnit && isCountUnit(it.purchaseUnit) && isCountUnit(it.unit)) {
    const bought = packs * (it.purchaseQuantity ?? 1);
    return { ok: bought + 1e-9 >= need, detail: `${bought} vs ${need} (counts)` };
  }
  if (conv && it.purchaseUnit) {
    const boughtG = convertToGrams(packs * (it.purchaseQuantity ?? 1), it.purchaseUnit, conv);
    const needG = convertToGrams(need, it.unit, conv);
    if (boughtG !== null && needG !== null) return { ok: boughtG + 1e-6 >= needG, detail: `${boughtG.toFixed(1)} g vs ${needG.toFixed(1)} g` };
  }
  return { ok: null, detail: `unrelatable: pack ${packs} x ${it.purchaseQuantity ?? "?"} ${it.purchaseUnit ?? "?"} vs need ${need} ${it.unit}` };
}

// ── GATE 2 — no "at least" beside a measure ────────────────────────────────
const MEASURE = /\b(\d+(?:\.\d+)?\s*)?(cup|cups|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|liters|quart|quarts|pint|pints|gallon|gallons)\b/i;
function gate2(line: string): string | null {
  const m = line.match(/at least[^,)]*/i);
  if (!m) return null;
  return MEASURE.test(m[0]) ? `"${line}" — "at least" carries a measure` : null;
}

// ── GATE 3 — no line mixes varieties H1 keeps apart ────────────────────────
function gate3(line: string, membersFolded: string[]): string | null {
  if (membersFolded.length < 2) return null;
  for (let i = 0; i < membersFolded.length; i++) {
    for (let j = i + 1; j < membersFolded.length; j++) {
      const a = membersFolded[i], b = membersFolded[j];
      if (classifyEdge(a, b).hClass === "H1" && classifyEdge(b, a).hClass === "H1") {
        const extraA = distinguishingTokens(b, a).filter((t) => H1_TOKENS.has(t));
        const extraB = distinguishingTokens(a, b).filter((t) => H1_TOKENS.has(t));
        if (extraA.length > 0 && extraB.length > 0) return `"${line}" folds ${a} with ${b} — H1 keeps them apart`;
      }
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
const relations = await loadRelationIndex(prisma);

const resolved = await prisma.mealPlanInstance.findMany({
  where: { OR: PLANS.map((p: string) => ({ id: { startsWith: p } })) },
  select: { id: true, userId: true, titleOverride: true, template: { select: { title: true } } },
});

const CATEGORY_TO_SECTION: Record<string, StoreSection> = {
  Produce: "produce", Protein: "meat_seafood", Dairy: "dairy_eggs", Pantry: "pantry",
  Bakery: "bakery_bread", Frozen: "frozen", Canned: "canned", Snacks: "snacks",
  Household: "household",
};

/**
 * Put `conversionRef` and the pack yield back on a final row, read off the
 * consolidated rows it was built from. Gate 1 needs them; the wire shape drops
 * them. Multi-source rows take the first member that carries one.
 */
function attachConv(
  finals: GenerateListOutputItem[],
  cons: ConsolidatedItem[],
): GenerateListOutputItem[] {
  const byBucket = new Map<string, ConsolidatedItem>();
  for (const c of cons) byBucket.set(`${normalizeIngredientName(c.canonicalName)}|${c.unit}`, c);
  return finals.map((it) => {
    let src: ConsolidatedItem | undefined;
    for (const k of it.sourceKeys) { const g = byBucket.get(k); if (g && (g.conversionRef || g.packYieldPerPack)) { src = g; break; } }
    if (!src) for (const k of it.sourceKeys) { const g = byBucket.get(k); if (g) { src = g; break; } }
    if (!src) src = byBucket.get(`${normalizeIngredientName(it.canonicalName)}|${it.unit}`);
    if (!src) return it;
    return Object.assign(Object.create(Object.getPrototypeOf(it) ?? Object.prototype), it, {
      conversionRef: src.conversionRef,
      packYieldUnit: src.packYieldUnit,
      packYieldPerPack: src.packYieldPerPack,
    }) as GenerateListOutputItem;
  });
}

const resCache = new Map<string, ResolveResult>();
async function resolveRecurring(raw: string): Promise<ResolveResult> {
  const norm = normalizeIngredientName(raw);
  const hit0 = resCache.get(norm);
  if (hit0) return hit0;
  const hit = await lookupIngredientByName(prisma, norm, raw);
  let row: CatalogRow | null = null;
  if (hit) {
    const r = await prisma.ingredient.findUnique({
      where: { id: hit.id },
      select: {
        id: true, canonicalName: true, displayName: true, category: true, defaultUnit: true,
        purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
        packYieldUnit: true, packYieldPerPack: true, conversionRef: true,
      },
    });
    if (r) row = { ...r, sectionKey: CATEGORY_TO_SECTION[r.category ?? ""] ?? "extras" };
  }
  const out: ResolveResult = { raw, norm, row, matchedVia: hit?.matchedVia ?? null };
  resCache.set(norm, out);
  return out;
}

const L: string[] = [];
const say = (s = "") => { L.push(s); };
say("[grocery] B3 — THE DRY RUN, Part A · September 29, 2026");
say("BEFORE = the real pipeline at HEAD: consolidate -> gap-fill -> final -> the");
say("         client's composePackName. Sonnet echoed; Haiku cached across passes.");
say("AFTER  = the same pipeline with the recurring items resolved through");
say("         lookupIngredientByName (canonical, then the IngredientAlias index),");
say("         matched on IDENTITY, and rendered under R3's two branches.");
say("");

const interceptAll: InterceptedWrite[] = [];
let nChanged = 0;
let recurringBefore = 0, recurringAfter = 0, gate4Fail = 0;
let g1Fail = 0, g1FailNew = 0, g1Unver = 0, g2Fail = 0, g3Fail = 0;
const gateNotes: string[] = [];
const changeLines: string[] = [];
const recurringLedger: string[] = [];

for (const short of PLANS) {
  const plan = resolved.find((p) => p.id.startsWith(short));
  if (!plan) { say(`## ${short} — NOT FOUND`); continue; }
  const title = plan.titleOverride ?? plan.template?.title ?? "";
  const db = interceptingPrisma(prisma, interceptAll);

  // ── BEFORE ──────────────────────────────────────────────────────────────
  const consB = await consolidatePlanIngredients({ prisma, planId: plan.id, userId: plan.userId, relations });
  const { aiSubset: subB } = partitionForAI(consB, relations);
  const optsB = { prisma: db, userId: undefined as unknown as string, client: stubClient(subB.map((s) => s.item)), relations };
  const filledB = await fillPurchaseSizesWithWriteBack(consB, optsB);
  const finalB = attachConv((await generateFinalGroceryList(title, filledB, KNOWN_SECTIONS, optsB)).items, filledB);
  const renderedB = finalB.map((it) => renderRow(it, undefined));

  // ── AFTER ───────────────────────────────────────────────────────────────
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId: plan.userId }, select: { recurringGroceryItems: true },
  });
  const texts = prefs?.recurringGroceryItems ?? [];
  const resolutions: ResolveResult[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const r = await resolveRecurring(t);
    if (seen.has(r.norm)) continue;
    seen.add(r.norm);
    resolutions.push(r);
  }

  const planRows = consB.filter((r) => !isTodaysSynthetic(r));
  const { rows: consA, fields } = applyRecurringResolution({
    planRows, resolutions, groupKey: (n) => relations.groupKey(n),
  });
  const { aiSubset: subA } = partitionForAI(consA, relations);
  const optsA = { prisma: db, userId: undefined as unknown as string, client: stubClient(subA.map((s) => s.item)), relations };
  const filledA = await fillPurchaseSizesWithWriteBack(consA, optsA);
  const finalA = attachConv((await generateFinalGroceryList(title, filledA, KNOWN_SECTIONS, optsA)).items, filledA);

  // carry the R3 fields onto the final rows through the consolidated row they
  // came from (sourceKeys name the bucket, which is canonical|unit)
  const fieldsByBucket = new Map<string, R3Fields>();
  for (const [row, f] of fields) fieldsByBucket.set(`${normalizeIngredientName(row.canonicalName)}|${row.unit}`, f);
  const renderedA = finalA.map((it) => {
    let f: R3Fields | undefined;
    for (const k of it.sourceKeys) { const g = fieldsByBucket.get(k); if (g) { f = g; break; } }
    if (!f) f = fieldsByBucket.get(`${normalizeIngredientName(it.canonicalName)}|${it.unit}`);
    return renderRow(it, f);
  });

  // ── the diff, per row ───────────────────────────────────────────────────
  say(`## ${short}  "${title}"   BEFORE ${finalB.length} rows / AFTER ${finalA.length} rows`);
  const keyOf = (it: GenerateListOutputItem) => `${normalizeIngredientName(it.canonicalName)}`;
  const bMap = new Map<string, { it: GenerateListOutputItem; r: typeof renderedB[number] }>();
  finalB.forEach((it, i) => bMap.set(keyOf(it) + "|" + it.unit, { it, r: renderedB[i] }));
  const aMap = new Map<string, { it: GenerateListOutputItem; r: typeof renderedA[number] }>();
  finalA.forEach((it, i) => aMap.set(keyOf(it) + "|" + it.unit, { it, r: renderedA[i] }));

  recurringBefore += finalB.filter((it) => it.isRecurringItem).length;
  const afterRec = finalA.filter((it) => it.isRecurringItem);
  recurringAfter += afterRec.length;

  // GATE 4 — every recurring TEXT still has a marked row
  for (const r of resolutions) {
    const want = r.row ? normalizeIngredientName(r.row.canonicalName) : r.norm;
    const found = afterRec.some((it) => normalizeIngredientName(it.canonicalName) === want
      || relations.groupKey(it.canonicalName) === relations.groupKey(want));
    if (!found) {
      gate4Fail++;
      gateNotes.push(`GATE4 [${short}] "${r.raw}" -> ${want}: no row on the AFTER list carries isRecurringItem`);
    }
  }

  // gates 1-3 on the AFTER list, with the BEFORE verdict for contrast
  finalA.forEach((it, i) => {
    const v = gate1(it, renderedA[i].packCount);
    if (v.ok === null) g1Unver++;
    else if (!v.ok) {
      g1Fail++;
      const before = bMap.get(keyOf(it) + "|" + it.unit);
      const wasOk = before ? gate1(before.it, before.r.packCount).ok : null;
      if (wasOk !== false) { g1FailNew++; gateNotes.push(`GATE1-NEW [${short}] ${renderedA[i].line} — ${v.detail}`); }
    }
    const g2 = gate2(renderedA[i].line);
    if (g2) { g2Fail++; gateNotes.push(`GATE2 [${short}] ${g2}`); }
    const members = it.sourceKeys.map((k) => k.split("|")[0]);
    const g3 = gate3(renderedA[i].line, [...new Set(members)]);
    if (g3) { g3Fail++; gateNotes.push(`GATE3 [${short}] ${g3}`); }
  });

  const allKeys = [...new Set([...bMap.keys(), ...aMap.keys()])].sort();
  for (const k of allKeys) {
    const b = bMap.get(k), a = aMap.get(k);
    if (b && a && b.r.line === a.r.line) continue;
    nChanged++;
    const line = b && a
      ? `[${short}] CHANGED\n        before: ${b.r.line}\n        after : ${a.r.line}`
      : b
        ? `[${short}] REMOVED\n        before: ${b.r.line}`
        : `[${short}] ADDED\n        after : ${a!.r.line}`;
    changeLines.push(`${String(nChanged).padStart(3, "0")}. ${line}`);
    say(`   ${String(nChanged).padStart(3, "0")}. ${b && a ? "CHANGED" : b ? "REMOVED" : "ADDED"}`);
    if (b) say(`        before: ${b.r.line}`);
    if (a) say(`        after : ${a.r.line}`);
  }

  for (const it of afterRec) {
    const i = finalA.indexOf(it);
    recurringLedger.push(`[${short}] ${renderedA[i].line}`);
  }
  say("");
}

say("=".repeat(78));
say(`rows changed / added / removed: ${nChanged}`);
say(`recurring-marked rows  BEFORE ${recurringBefore}   AFTER ${recurringAfter}`);
say(`GATE 1 (packs x size >= need)   fails ${g1Fail} (new: ${g1FailNew})   unverifiable ${g1Unver}`);
say(`GATE 2 ("at least" + a measure) fails ${g2Fail}`);
say(`GATE 3 (H1 varieties on a line) fails ${g3Fail}`);
say(`GATE 4 (a recurring row keeps its mark) fails ${gate4Fail}`);
say(`Haiku: ${haikuCalls} real calls, ${haikuHits} cache hits`);
say(`intercepted Ingredient writes (applied to nothing): ${interceptAll.length}`);
const byWriteName = new Map<string, number>();
for (const w of interceptAll) {
  const id = JSON.stringify((w.where as { id?: string })?.id ?? w.where);
  byWriteName.set(id, (byWriteName.get(id) ?? 0) + 1);
}
say(`  distinct ingredient ids written: ${byWriteName.size}`);
say("");
if (gateNotes.length) { say("## GATE NOTES"); for (const g of gateNotes) say("  " + g); say(""); }
say("## THE RECURRING ROWS, AFTER, IN FULL");
for (const r of recurringLedger) say("  " + r);

writeFileSync(join(OUT, "preview.txt"), L.join("\n") + "\n");
console.log(L.slice(-80).join("\n"));
console.log(`\n-> ${join(OUT, "preview.txt")}   (${L.length} lines)`);
await prisma.$disconnect();
