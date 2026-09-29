// ─────────────────────────────────────────────────────────────────────────────
// THE GROCERY CENSUS HARNESS — Part A. READ-ONLY against the dev database.
//
// Runs the REAL generate pipeline, in process, through the DI seams production
// already exposes, and STOPS BEFORE PERSISTING. Nothing in src/ is touched.
//
//   loadRelationIndex        → the same index the route loads
//   consolidatePlanIngredients → Block A (deterministic)
//   fillPurchaseSizesWithWriteBack → Block B gap-fill (Haiku) — WRITE-BACK INTERCEPTED
//   generateFinalGroceryList → Block B final pass (Sonnet)
//   ── STOP. No GroceryList / GroceryListItem row is created. ──
//
// 🔴 CATALOG INTERCEPTION. Canon says the pipeline writes to the SHARED catalog
// while generating (BUG-124 / D-WS9-226). The ONE write on this path is
// groceryListAI.ts:201 `opts.prisma.ingredient.update`, flushed by
// `opts.prisma.$transaction(writeBackOps)` at :213. Both are intercepted here:
//   - every `ingredient` WRITE method is replaced by a recorder that applies
//     nothing and returns a resolved sentinel;
//   - `$transaction` called with an ARRAY is Promise.all'd instead of being
//     handed to Prisma (Prisma rejects non-PrismaPromise members, which is the
//     caveat the ws9-bug241 prior art carries).
// Reads pass straight through. LLMCallLog writes pass straight through — they
// are the cost ledger and the prompt explicitly permits them.
//
// AI ATTRIBUTION: every call runs with userId UNDEFINED, i.e. a system-triggered
// CLI row (LLMCallLog.userId NULL). That keeps the census off every real user's
// ledger and out of the per-user spend guard. The guard's three env vars are
// unset locally, so this changes no behaviour — only attribution.
//
// MODES
//   --mode live  (default) the real pipeline, real Sonnet + Haiku.
//   --mode det   the AI-REMOVED CONTROL. Identical code path, but the Sonnet
//                client is a stub that ECHOES partitionForAI's subset back
//                unchanged. The deterministic half, the relation index, the
//                pack resolution, the conservation guard and the placement
//                logic all still run; only the model's judgement is removed.
//                Costs $0 (the Haiku gap-fill still runs — it is not the pass
//                under question and its misses must still be filled).
//
// USAGE
//   node --env-file=.env --import tsx scripts/grocery-census/census.ts \
//        --plans <planId,planId,...> [--runs 1] [--mode live|det] [--tag name]
//   node --env-file=.env --import tsx scripts/grocery-census/census.ts --corpus
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient, type StoreSection } from "@prisma/client";
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  consolidatePlanIngredients,
  type ConsolidatedItem,
} from "../../src/lib/groceryList.js";
import {
  fillPurchaseSizesWithWriteBack,
  generateFinalGroceryList,
  partitionForAI,
} from "../../src/lib/groceryListAI.js";
import { loadRelationRows } from "../../src/lib/relationIndexLoader.js";
import { buildRelationIndex } from "../../src/lib/ingredientRelations.js";
import {
  estimateCostUsdFromRate,
  getModelRate,
} from "../../src/lib/ai/promptRegistry.js";
import type { GenerateListOutputItem } from "../../src/lib/ai/schemas/grocery.js";

// The CLIENT's own pure compose functions — the exact code the phone runs.
// Verified RN-free: lib/format/grocery.ts imports only ./quantity and
// ../quantity, both of which are leaves with zero imports.
// ⚠️ artifacts/kiwi has no `"type": "module"`, so tsx transpiles it to CJS while
// api-server is ESM. A named import across that boundary fails; the namespace
// arrives under `default`. Unwrap once, here, and use the real functions.
import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";

interface GroceryFormat {
  composePackName: (
    name: string,
    purchaseUnit: string | null | undefined,
    purchaseDisplay: string | null | undefined,
    needAmount?: string | number | null,
    needUnit?: string | null,
    isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (
    quantityAmount: string | undefined,
    quantityUnit: string | undefined,
    fallback: string,
  ) => string;
  renderedPack: (
    purchaseDisplay: string | null | undefined,
    needAmount: string | number | null | undefined,
    needUnit: string | null | undefined,
    purchaseUnit: string | null | undefined,
    isPantryStaple?: boolean,
  ) => { packCount: number; packSizeText?: string } | null;
}

const ns = groceryFormatNs as unknown as { default?: GroceryFormat } & GroceryFormat;
const G: GroceryFormat = ns.composePackName ? ns : (ns.default as GroceryFormat);
if (typeof G?.composePackName !== "function") {
  throw new Error("could not load artifacts/kiwi/lib/format/grocery — the client compose is the render authority and must not be re-implemented");
}
const { composePackName, formatNeedText, renderedPack } = G;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const KNOWN_SECTIONS: StoreSection[] = [
  "produce", "meat_seafood", "dairy_eggs", "bakery_bread", "pantry",
  "canned", "frozen", "snacks", "household", "extras",
];

const GROCERY_PROMPT_KEYS = [
  "grocery.generate_list",
  "grocery.gap_fill_purchase_size",
];

// ── the fence ────────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const DB_HOST = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!DB_HOST.includes("ep-broad-haze")) {
  throw new Error(`REFUSING: DATABASE_URL host is not the dev branch (${DB_HOST.slice(0, 8)}…)`);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// ── argv ─────────────────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const HAS = (name: string) => process.argv.includes(`--${name}`);

// ── catalog write interception ───────────────────────────────────────────────
export interface InterceptedWrite {
  table: string;
  op: string;
  where: unknown;
  data: unknown;
}

const INGREDIENT_WRITE_OPS = new Set([
  "update", "updateMany", "upsert", "create", "createMany",
  "delete", "deleteMany",
]);

function interceptingPrisma(base: PrismaClient, sink: InterceptedWrite[]): PrismaClient {
  const realIngredient = (base as unknown as Record<string, Record<string, unknown>>)["ingredient"];
  const ingredientProxy = new Proxy(realIngredient, {
    get(target, prop: string) {
      if (INGREDIENT_WRITE_OPS.has(prop)) {
        return async (args: { where?: unknown; data?: unknown }) => {
          sink.push({
            table: "Ingredient",
            op: prop,
            where: args?.where ?? null,
            data: args?.data ?? null,
          });
          // A resolved sentinel. Never touches the database.
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
      // The gap-fill flushes its write-backs with the ARRAY form. Those members
      // are our sentinels, not PrismaPromises, so Prisma would reject them.
      // Await them ourselves; the interactive (callback) form is untouched.
      if (prop === "$transaction") {
        const real = Reflect.get(target, prop, recv) as (...a: unknown[]) => unknown;
        return (first: unknown, ...rest: unknown[]) =>
          Array.isArray(first)
            ? Promise.all(first as Promise<unknown>[])
            : (real as (...a: unknown[]) => unknown).call(target, first, ...rest);
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as PrismaClient;
}

// ── the AI spy / the AI-removed stub ─────────────────────────────────────────
export interface AICall {
  model: string;
  temperature: unknown;
  maxTokens: unknown;
  promptHash: string;
  outputHash: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

function spyClient(): { client: Pick<Anthropic, "messages">; calls: AICall[] } {
  const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const calls: AICall[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        const t0 = Date.now();
        const res = (await real.messages.create(params)) as Anthropic.Message;
        const text = res.content
          .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
          .join("");
        calls.push({
          model: params.model,
          temperature: (params as { temperature?: unknown }).temperature,
          maxTokens: (params as { max_tokens?: unknown }).max_tokens,
          promptHash: sha(JSON.stringify(params)),
          outputHash: sha(text),
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          ms: Date.now() - t0,
        });
        return res;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, calls };
}

/**
 * The AI-REMOVED CONTROL. Haiku gap-fill still goes to the real API (it is not
 * the pass under question); the Sonnet final pass is answered by an echo of the
 * exact subset partitionForAI routed to it, so generateFinalGroceryList's own
 * deterministic half, guards and placement all still run for real.
 */
function echoClient(
  aiSubset: ConsolidatedItem[],
): { client: Pick<Anthropic, "messages">; calls: AICall[]; clamped: string[] } {
  const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const calls: AICall[] = [];
  const clamped: string[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        // Only the Sonnet final pass is stubbed. Haiku gap-fill runs for real.
        if (!String(params.model).includes("sonnet")) {
          const t0 = Date.now();
          const res = (await real.messages.create(params)) as Anthropic.Message;
          const text = res.content
            .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
            .join("");
          calls.push({
            model: params.model,
            temperature: (params as { temperature?: unknown }).temperature,
            maxTokens: (params as { max_tokens?: unknown }).max_tokens,
            promptHash: sha(JSON.stringify(params)),
            outputHash: sha(text),
            inputTokens: res.usage?.input_tokens ?? 0,
            outputTokens: res.usage?.output_tokens ?? 0,
            ms: Date.now() - t0,
          });
          return res;
        }
        const items = aiSubset.map((it) => {
          // The schema demands quantity > 0. A zero-quantity consolidated row
          // would be refused by the real model too; record and clamp so the
          // control still produces a comparable list.
          let q = it.quantity;
          if (!(q > 0)) {
            clamped.push(`${it.canonicalName}|${it.unit}|${q}`);
            q = 0.0001;
          }
          return {
            canonicalName: it.canonicalName,
            displayName: it.displayName,
            quantity: q,
            unit: it.unit,
            sectionKey: it.sectionKey,
            isUniversalStaple: it.isUniversalStaple,
            isUserPantryStaple: it.isUserPantryStaple,
            isRecurringItem: it.isRecurringItem,
            notes: null,
            isAmbiguous: false,
            wasAiInferred: false,
          };
        });
        const text = JSON.stringify({ items });
        calls.push({
          model: String(params.model),
          temperature: (params as { temperature?: unknown }).temperature,
          maxTokens: (params as { max_tokens?: unknown }).max_tokens,
          promptHash: sha(JSON.stringify(params)),
          outputHash: sha(text),
          inputTokens: 0,
          outputTokens: 0,
          ms: 0,
        });
        return {
          id: "echo",
          type: "message",
          role: "assistant",
          model: String(params.model),
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, calls, clamped };
}

// ── the render: exactly what the phone composes ──────────────────────────────
//
// app/grocery-list/[id].tsx:1450 (needText) and :1490 (packName), with the wire
// mapping from lib/api/grocery.ts:226 — quantityAmount = String(wire.quantity),
// quantityUnit = wire.unit || undefined, isUniversalStaple folds
// wire.isUniversalStaple || wire.isUserPantryStaple.
//
// A freshly generated row has no user override (BUG-240 override columns are
// only ever populated by a user PATCH), so the override argument is omitted —
// which is exactly the state of every row on a just-generated list.
export interface RenderedRow {
  packName: string;
  needText: string;
  line: string;
  packCount: number | null;
  packSizeText: string | null;
}

function renderRow(it: GenerateListOutputItem): RenderedRow {
  const quantityAmount = String(it.quantity);
  const quantityUnit = it.unit || undefined;
  const staple = it.isUniversalStaple || it.isUserPantryStaple;
  const needText = formatNeedText(
    quantityAmount,
    quantityUnit,
    quantityUnit ? `${it.quantity} ${it.unit}` : String(it.quantity),
  );
  const packName = composePackName(
    it.displayName,
    it.purchaseUnit ?? undefined,
    it.purchaseDisplay ?? undefined,
    quantityAmount,
    quantityUnit,
    staple,
  );
  const rp = renderedPack(
    it.purchaseDisplay ?? undefined,
    quantityAmount,
    quantityUnit,
    it.purchaseUnit ?? undefined,
    staple,
  );
  const need = needText.trim();
  return {
    packName,
    needText: need,
    line: need ? `${packName} (${need})` : packName,
    packCount: rp?.packCount ?? null,
    packSizeText: rp?.packSizeText ?? null,
  };
}

// ── one run ──────────────────────────────────────────────────────────────────
export interface RunResult {
  planId: string;
  planTitle: string;
  userId: string;
  mode: string;
  run: number;
  startedAt: string;
  finishedAt: string;
  consolidatedCount: number;
  aiSubsetCount: number;
  deterministicCount: number;
  finalCount: number;
  consolidated: ConsolidatedItem[];
  aiSubsetKeys: string[];
  final: GenerateListOutputItem[];
  rendered: RenderedRow[];
  interceptedWrites: InterceptedWrite[];
  aiCalls: AICall[];
  ledger: { promptKey: string; model: string; costUsd: number; inputTokens: number; outputTokens: number; success: boolean; retryCount: number }[];
  costUsd: number;
  clampedForControl?: string[];
  error?: string;
}

// ⚠️ COST IS MEASURED FROM THE SDK, NOT FROM LLMCallLog.
//
// The DATABASE_URL in artifacts/api-server/.env authenticates as `cookbook_ro`,
// a role holding SELECT and nothing else (`permission denied for table
// llm_call_logs` on INSERT, confirmed). runAICall's writeLogSafely swallows
// that failure by design, so the census's own calls leave NO ledger row and
// "measure from LLMCallLog" is not available to this harness.
//
// So cost is computed the way runAICall itself computes it — the SAME
// estimateCostUsdFromRate over the SAME SystemSetting-backed rate — but applied
// to the token counts the Anthropic SDK actually returned for each call. That
// is a direct measurement of this run rather than a read of a row about it.
async function costOf(calls: AICall[]): Promise<number> {
  let total = 0;
  for (const c of calls) {
    if (c.inputTokens === 0 && c.outputTokens === 0) continue; // the echo stub
    const rate = await getModelRate(c.model, prisma);
    total += estimateCostUsdFromRate(rate, c.inputTokens, c.outputTokens);
  }
  return total;
}

/** Whether ANY ledger row landed for this window — expected to be none. */
async function ledgerSince(from: Date): Promise<RunResult["ledger"]> {
  try {
    const rows = await prisma.lLMCallLog.findMany({
      where: {
        createdAt: { gte: from },
        userId: null,
        guestSessionId: null,
        promptKey: { in: GROCERY_PROMPT_KEYS },
      },
      select: {
        promptKey: true, model: true, costEstimateUsd: true,
        inputTokens: true, outputTokens: true, success: true, retryCount: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({
      promptKey: r.promptKey,
      model: r.model,
      costUsd: Number(r.costEstimateUsd),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      success: r.success,
      retryCount: r.retryCount,
    }));
  } catch {
    return [];
  }
}

/** Corpus ids are given by their 8-char prefix; resolve to the full id once. */
async function resolvePlanId(prefix: string): Promise<string> {
  if (prefix.length === 36) return prefix;
  const hits = await prisma.mealPlanInstance.findMany({
    where: { id: { startsWith: prefix } },
    select: { id: true },
  });
  if (hits.length !== 1) {
    throw new Error(`plan prefix ${prefix} matched ${hits.length} plans`);
  }
  return hits[0].id;
}

async function runOnce(planIdIn: string, mode: string, run: number): Promise<RunResult> {
  const planId = await resolvePlanId(planIdIn);
  const plan = await prisma.mealPlanInstance.findUniqueOrThrow({
    where: { id: planId },
    select: {
      id: true, userId: true, titleOverride: true,
      template: { select: { title: true } },
    },
  });
  const planTitle = plan.titleOverride ?? plan.template?.title ?? "";

  const startedAt = new Date();
  const writes: InterceptedWrite[] = [];
  const db = interceptingPrisma(prisma, writes);

  // Reads only — the raw client is fine and keeps the proxy off the hot path.
  //
  // ── [grocery] B2 — THE ROWS, NOT JUST THE INDEX ──────────────────────────
  //
  // This harness's whole claim is that it runs THE REAL PIPELINE AT HEAD. At HEAD
  // routes/groceryLists.ts passes `relationRows` as well as `relations`, because
  // the subsumes reader has to rebuild its index once it knows what the plan
  // demanded (H3's gate). A census that passed only the index would silently
  // measure the pre-B2 path and report that B2 changed nothing — a false negative
  // with no symptom. Same rows build the index, so partitionForAI and the
  // consolidator still agree about what one ingredient is.
  const relationRows = await loadRelationRows(prisma);
  const relations = buildRelationIndex(relationRows);
  const consolidated = await consolidatePlanIngredients({
    prisma, planId: plan.id, userId: plan.userId, relations, relationRows,
  });

  // partitionForAI is pure and exported; calling it here tells us the split and
  // supplies the control's echo set. generateFinalGroceryList calls it again
  // internally with the same index, so the two agree by construction.
  const { deterministic, aiSubset } = partitionForAI(consolidated, relations);

  const spy = mode === "det"
    ? echoClient(aiSubset.map((s) => s.item))
    : spyClient();

  // ⚠️ userId undefined = a system-triggered CLI row. See the header.
  const aiOpts = {
    prisma: db,
    userId: undefined as unknown as string,
    client: spy.client,
    relations,
  };

  let final: GenerateListOutputItem[] = [];
  let error: string | undefined;
  try {
    const withSizes = await fillPurchaseSizesWithWriteBack(consolidated, aiOpts);
    const result = await generateFinalGroceryList(
      planTitle, withSizes, KNOWN_SECTIONS, aiOpts,
    );
    final = result.items;
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  // ── STOP. Nothing is persisted. ──

  const finishedAt = new Date();
  const ledger = await ledgerSince(startedAt);
  const costUsd = await costOf(spy.calls);

  return {
    planId: plan.id,
    planTitle,
    userId: plan.userId,
    mode,
    run,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    consolidatedCount: consolidated.length,
    aiSubsetCount: aiSubset.length,
    deterministicCount: deterministic.length,
    finalCount: final.length,
    consolidated,
    aiSubsetKeys: aiSubset.map((s) => `${s.item.canonicalName}|${s.item.unit}`),
    final,
    rendered: final.map(renderRow),
    interceptedWrites: writes,
    aiCalls: spy.calls,
    ledger,
    costUsd,
    clampedForControl: mode === "det" ? (spy as { clamped?: string[] }).clamped : undefined,
    error,
  };
}

// ── text rendering of a saved run ────────────────────────────────────────────
function toText(r: RunResult): string {
  const L: string[] = [];
  L.push(`PLAN ${r.planId}  "${r.planTitle}"`);
  L.push(`mode=${r.mode} run=${r.run}  user=${r.userId}`);
  L.push(`consolidated=${r.consolidatedCount}  (deterministic ${r.deterministicCount} / AI subset ${r.aiSubsetCount})  final=${r.finalCount}`);
  L.push(`cost=$${r.costUsd.toFixed(4)}  aiCalls=${r.aiCalls.length}  interceptedCatalogWrites=${r.interceptedWrites.length}`);
  if (r.error) L.push(`ERROR: ${r.error}`);
  L.push("");
  L.push("── RENDERED LINES (exactly as the phone composes them) ──");
  const bySection = new Map<string, number[]>();
  r.final.forEach((it, i) => {
    const a = bySection.get(it.sectionKey) ?? [];
    a.push(i);
    bySection.set(it.sectionKey, a);
  });
  for (const [section, idxs] of bySection) {
    L.push(`  [${section}]`);
    for (const i of idxs) {
      const it = r.final[i];
      const rd = r.rendered[i];
      const flags = [
        it.isUniversalStaple ? "UNIV" : "",
        it.isUserPantryStaple ? "PANTRY" : "",
        it.isRecurringItem ? "RECUR" : "",
        it.isAmbiguous ? "AMBIG" : "",
        it.wasAiInferred ? "AI" : "",
      ].filter(Boolean).join(",");
      L.push(`    ${String(i).padStart(3)}  ${rd.line}`);
      L.push(`         raw: ${it.canonicalName} | need ${it.quantity} ${it.unit} | pack ${it.purchaseQuantity ?? "-"} ${it.purchaseUnit ?? "-"} (${it.purchaseDisplay ?? "-"}) | packs=${rd.packCount ?? "-"} | ${flags}`);
      if (it.notes) L.push(`         notes: ${it.notes}`);
    }
  }
  L.push("");
  L.push("── CONSOLIDATED (pre-AI, deterministic) ──");
  for (const c of r.consolidated) {
    L.push(`    ${c.canonicalName} | ${c.quantity} ${c.unit} | ${c.sectionKey} | pack ${c.purchaseQuantity ?? "-"} ${c.purchaseUnit ?? "-"} (${c.purchaseDisplay ?? "-"}) | src=${c.sources.length}`);
  }
  L.push("");
  L.push("── INTERCEPTED CATALOG WRITES (recorded, NOT applied) ──");
  if (r.interceptedWrites.length === 0) L.push("    (none)");
  for (const w of r.interceptedWrites) {
    L.push(`    ${w.table}.${w.op}  where=${JSON.stringify(w.where)}  data=${JSON.stringify(w.data)}`);
  }
  L.push("");
  L.push("── AI CALLS ──");
  for (const c of r.aiCalls) {
    L.push(`    ${c.model}  temp=${c.temperature}  in=${c.inputTokens} out=${c.outputTokens}  ${c.ms}ms  prompt=${c.promptHash} output=${c.outputHash}`);
  }
  return L.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`DB HOST = ${DB_HOST.slice(0, 12)}… (dev branch confirmed)`);

  const planArg = arg("plans");
  if (!planArg) throw new Error("need --plans <id,id,...>");
  const planIds = planArg.split(",").map((s) => s.trim()).filter(Boolean);
  const runs = Number(arg("runs", "1"));
  const mode = arg("mode", "live")!;
  const tag = arg("tag", mode)!;
  const budget = Number(arg("budget", "10"));

  let spent = 0;
  const index: Record<string, unknown>[] = [];

  for (const planId of planIds) {
    for (let run = 1; run <= runs; run++) {
      if (spent >= budget) {
        console.log(`\n🛑 BUDGET REACHED ($${spent.toFixed(4)} of $${budget}); stopping.`);
        break;
      }
      process.stdout.write(`\n▶ ${planId.slice(0, 8)} ${mode} run ${run}/${runs} … `);
      const r = await runOnce(planId, mode, run);
      spent += r.costUsd;
      const base = `${tag}__${planId.slice(0, 8)}__r${run}`;
      writeFileSync(join(OUT, `${base}.json`), JSON.stringify(r, null, 1));
      writeFileSync(join(OUT, `${base}.txt`), toText(r));
      console.log(
        `${r.finalCount} rows  $${r.costUsd.toFixed(4)}  writes=${r.interceptedWrites.length}${r.error ? `  ERROR ${r.error}` : ""}`,
      );
      index.push({
        file: `${base}.json`, planId, mode, run,
        consolidated: r.consolidatedCount, aiSubset: r.aiSubsetCount,
        final: r.finalCount, cost: r.costUsd,
        writes: r.interceptedWrites.length, error: r.error ?? null,
      });
    }
    if (spent >= budget) break;
  }

  writeFileSync(
    join(OUT, `_index__${tag}.json`),
    JSON.stringify({ tag, mode, runs, spentUsd: spent, entries: index }, null, 1),
  );
  console.log(`\n── ${tag}: ${index.length} lists, $${spent.toFixed(4)} ──`);
}

if (!HAS("no-main")) {
  main()
    .catch((e) => {
      console.error("FAILED:", e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
