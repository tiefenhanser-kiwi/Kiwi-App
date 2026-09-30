// [grocery] F Part A — read the two dev lists the device pass used, and render
// each row exactly as the phone composes it. Read-only.
//
//   node --env-file=.env --import tsx scripts/grocery-f/lists.ts <listIdPrefix...>

import { PrismaClient } from "@prisma/client";
// artifacts/kiwi has no "type": "module", so tsx transpiles it to CJS while
// api-server is ESM: the namespace arrives under `default`. Same unwrap the
// census harness uses (scripts/grocery-census/census.ts:75) — reused, not
// rewritten, so the render authority stays one module.
import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ns = groceryFormatNs as any;
const G = ns.composePackName ? ns : ns.default;
if (typeof G?.composePackName !== "function") {
  throw new Error("could not load artifacts/kiwi/lib/format/grocery");
}
const { composePackName, formatNeedText, renderedPack } = G;

function assertDevHost() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) {
    throw new Error("refusing: DATABASE_URL host is not the dev branch");
  }
  console.log(`host check: PASS (dev branch)`);
}

async function main() {
  assertDevHost();
  const prisma = new PrismaClient();
  const prefixes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const p of prefixes) {
    const list = await prisma.groceryList.findFirst({
      where: { id: { startsWith: p } },
      include: {
        items: { orderBy: [{ storeSection: "asc" }, { displayName: "asc" }], where: { deletedAt: null } },
      },
    });
    if (!list) { console.log(`\n### ${p} — NOT FOUND`); continue; }
    console.log(`\n\n### list ${list.id}  plan=${list.mealPlanInstanceId}  items=${list.items.length}`);
    let section = "";
    for (const it of list.items) {
      const r = it as unknown as Record<string, unknown>;
      if (it.storeSection !== section) { section = it.storeSection; console.log(`\n── ${section.toUpperCase()} ──`); }
      const name = (r.userResolvedTo as string | null) ?? it.displayName;
      const override = {
        quantity: (r.purchaseQuantityOverride as number | null) ?? null,
        display: (r.purchaseDisplayOverride as string | null) ?? null,
      };
      const needText = formatNeedText(
        String(it.quantity),
        it.unit || undefined,
        `${it.quantity} ${it.unit}`.trim(),
      );
      const packName = composePackName(
        name,
        it.purchaseUnit,
        it.purchaseDisplay,
        String(it.quantity),
        it.unit,
        it.isUniversalStaple || it.isUserPantryStaple,
        override,
      );
      const rp = renderedPack(
        it.purchaseDisplay,
        String(it.quantity),
        it.unit,
        it.purchaseUnit,
        it.isUniversalStaple || it.isUserPantryStaple,
        override,
        (r.packCount as number | null) ?? null,
      );
      const flags = [
        it.isUniversalStaple ? "UNIV" : null,
        it.isUserPantryStaple ? "PANTRY" : null,
        it.isRecurringItem ? "RECUR" : null,
      ].filter(Boolean).join(",");
      console.log(
        `${packName} (${needText})\n      name="${it.displayName}" pu=${it.purchaseUnit} pq=${it.purchaseQuantity} pd="${it.purchaseDisplay}" packCount=${r.packCount} need=${it.quantity} ${it.unit} ${flags ? "· " + flags : ""} · rendered.packCount=${rp?.packCount ?? "null"}`,
      );
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
