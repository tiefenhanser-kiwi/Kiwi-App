// [grocery] B2 · Part C — THE WIRING SMOKE. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/smoke.ts  -> out/smoke.txt
//
// The REAL production functions over the named-case plans, with NO shadow. Part
// A2's dry run proved the design; this proves the CODE, which is a different
// claim. Sonnet is echoed so the output is deterministic; the Haiku gap-fill runs
// for real and every Ingredient write is intercepted.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient, type StoreSection } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

import { loadRelationRows } from "../../src/lib/relationIndexLoader";
import { buildRelationIndex } from "../../src/lib/ingredientRelations";
import { consolidatePlanIngredients, type ConsolidatedItem } from "../../src/lib/groceryList";
import {
  fillPurchaseSizesWithWriteBack,
  generateFinalGroceryList,
  partitionForAI,
} from "../../src/lib/groceryListAI";
import type { GenerateListOutputItem } from "../../src/lib/ai/schemas/grocery";
import { instacartSearchName } from "../../src/lib/retailers/instacartName";
import { splitRiderForRetailer } from "../../src/lib/groceryVarietyRider";

import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";
interface GroceryFormat {
  composePackName: (
    name: string, purchaseUnit?: string | null, purchaseDisplay?: string | null,
    needAmount?: string | number | null, needUnit?: string | null, isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (a: string | undefined, u: string | undefined, f: string) => string;
}
const ns = groceryFormatNs as unknown as { default?: Partial<GroceryFormat> } & Partial<GroceryFormat>;
const G = (ns.composePackName ? ns : ns.default) as GroceryFormat | undefined;
if (typeof G?.composePackName !== "function") throw new Error("client render not loadable");
const { composePackName, formatNeedText } = G;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const PLANS = ["f5556c19", "163875ec", "247cd7bb", "425da049", "6e952e32", "56b03a57", "a8b0bbd5"];
const KNOWN_SECTIONS: StoreSection[] = [
  "produce", "meat_seafood", "dairy_eggs", "pantry", "bakery_bread",
  "canned", "frozen", "snacks", "household", "extras",
];

const writes: { op: string; where: unknown }[] = [];
const WRITE_OPS = new Set(["update", "updateMany", "upsert", "create", "createMany", "delete", "deleteMany"]);
function interceptingPrisma(base: PrismaClient): PrismaClient {
  const real = (base as unknown as Record<string, Record<string, unknown>>)["ingredient"];
  const proxy = new Proxy(real, {
    get(t, prop: string) {
      if (WRITE_OPS.has(prop)) {
        return async (args: { where?: unknown }) => {
          writes.push({ op: prop, where: args?.where ?? null });
          return { __intercepted: true };
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return new Proxy(base, {
    get(t, prop: string, recv) {
      if (prop === "ingredient") return proxy;
      if (prop === "$transaction") {
        const r = Reflect.get(t, prop, recv) as (...a: unknown[]) => unknown;
        return (first: unknown, ...rest: unknown[]) =>
          Array.isArray(first) ? Promise.all(first as Promise<unknown>[]) : r.call(t, first, ...rest);
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as PrismaClient;
}

function echo(aiSubset: ConsolidatedItem[]): Pick<Anthropic, "messages"> {
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        if (!String(params.model).includes("sonnet")) {
          const { default: Real } = await import("@anthropic-ai/sdk");
          return (await new Real({ apiKey: process.env.ANTHROPIC_API_KEY! }).messages.create(
            params,
          )) as Anthropic.Message;
        }
        const items = aiSubset.map((it) => ({
          canonicalName: it.canonicalName, displayName: it.displayName,
          quantity: it.quantity > 0 ? it.quantity : 0.0001, unit: it.unit,
          sectionKey: it.sectionKey, isUniversalStaple: it.isUniversalStaple,
          isUserPantryStaple: it.isUserPantryStaple, isRecurringItem: it.isRecurringItem,
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

function line(it: GenerateListOutputItem): string {
  const needText = formatNeedText(String(it.quantity), it.unit || undefined, "").trim();
  const pack = composePackName(
    it.displayName, it.purchaseUnit ?? undefined, it.purchaseDisplay ?? undefined,
    String(it.quantity), it.unit || undefined,
    it.isUniversalStaple || it.isUserPantryStaple,
  );
  return needText ? `${pack} (${needText})` : pack;
}

const relationRows = await loadRelationRows(prisma);
const relations = buildRelationIndex(relationRows);
const db = interceptingPrisma(prisma);
const plans = await prisma.mealPlanInstance.findMany({
  where: { OR: PLANS.map((p) => ({ id: { startsWith: p } })) },
  select: { id: true, userId: true, titleOverride: true, template: { select: { title: true } } },
});

const L: string[] = [];
L.push("[grocery] B2 — THE WIRING SMOKE · the REAL functions, no shadow");
L.push("");
const INTEREST = /onion|chicken thigh|bell pepper|parsley|cheddar|marzano|crushed tomato|garlic|vegetable oil|neutral|cherry tomato|rotisserie/i;

for (const short of PLANS) {
  const plan = plans.find((p) => p.id.startsWith(short));
  if (!plan) { L.push(`## ${short} NOT FOUND`); continue; }
  const title = plan.titleOverride ?? plan.template?.title ?? "";
  const cons = await consolidatePlanIngredients({
    prisma, planId: plan.id, userId: plan.userId, relations, relationRows,
  });
  const { aiSubset } = partitionForAI(cons, relations);
  const opts = {
    prisma: db, userId: undefined as unknown as string,
    client: echo(aiSubset.map((s) => s.item)), relations,
  };
  const filled = await fillPurchaseSizesWithWriteBack(cons, opts);
  const final = (await generateFinalGroceryList(title, filled, KNOWN_SECTIONS, opts)).items;

  L.push(`## ${short}  (${final.length} rows)`);
  for (const it of final) {
    if (!INTEREST.test(it.canonicalName) && !INTEREST.test(it.displayName)) continue;
    L.push(`   ${line(it)}`);
    if (it.displayName.includes(", at least ")) {
      const split = splitRiderForRetailer(it.displayName, Math.max(1, Math.ceil(it.quantity)));
      L.push(`       H7 split -> ${split.map((s) => `{${instacartSearchName(s.name)} x${s.quantity}}`).join(" · ")}`);
    }
  }
  L.push("");
}
L.push(`Ingredient writes attempted: ${writes.length} (all intercepted)`);
writeFileSync(join(OUT, "smoke.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
await prisma.$disconnect();
