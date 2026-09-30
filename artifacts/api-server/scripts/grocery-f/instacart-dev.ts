// [grocery] F Part B / F7 — make device-pass item 11 testable on DEV, and show
// what the order would carry.
//
// Two jobs, both DEV-only:
//   --enable   set `retailer.instacart_enabled` true on the dev database.
//   (default)  build the Instacart payload IN PROCESS for a list and print
//              every line item. Instacart is NOT called.
//
// ⚠️ THE PAYLOAD IS BUILT THROUGH THE REAL CODE, both halves. The phone's
// selection (`selectInstacartRows`) and per-row pack data (`instacartItemForRow`)
// come from artifacts/kiwi/lib/instacartOrder.ts; the wire body comes from
// `composeInstacartPayload`. Nothing about either is re-implemented here, so
// what prints is what a tap would send.
//
//   node --env-file=.env --import tsx scripts/grocery-f/instacart-dev.ts --enable
//   node --env-file=.env --import tsx scripts/grocery-f/instacart-dev.ts 14805f6e

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import { INSTACART_ENABLED_SETTING_KEY } from "../../src/lib/retailers/instacartFlag";
import {
  composeInstacartPayload,
  INSTACART_DEFAULT_TITLE,
} from "../../src/lib/retailers/instacartPayload";

// artifacts/kiwi transpiles to CJS while api-server is ESM; the namespace
// arrives under `default`. Same unwrap census.ts:75 uses.
import * as orderNs from "../../../kiwi/lib/instacartOrder.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const O: any = (orderNs as any).selectInstacartRows ? orderNs : (orderNs as any).default;

function assertDevHost(): void {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: DATABASE_URL host is not the dev branch");
  console.log("host check: PASS (dev branch)");
}

/** Presence and shape only — a key is never printed, not even in part. */
function reportCredentials(): void {
  const key = process.env.INSTACART_API_KEY ?? "";
  const base = process.env.INSTACART_API_BASE_URL ?? "";
  let host = "";
  try { host = new URL(base).hostname; } catch { /* unparseable */ }
  const tld = host.includes(".") ? host.slice(host.lastIndexOf(".")) : "(none)";
  console.log(`INSTACART_API_KEY present: ${key.trim().length > 0}`);
  console.log(`INSTACART_API_BASE_URL host suffix: ${tld}  ·  ends in .tools: ${host.endsWith(".tools")}`);
}

async function enable(prisma: PrismaClient): Promise<void> {
  const row = await prisma.systemSetting.findUnique({ where: { key: INSTACART_ENABLED_SETTING_KEY } });
  console.log(`\nbefore: ${row ? JSON.stringify(row.value) : "(no row — reads false, fails closed)"}`);
  await prisma.systemSetting.upsert({
    where: { key: INSTACART_ENABLED_SETTING_KEY },
    update: { value: true },
    create: {
      key: INSTACART_ENABLED_SETTING_KEY,
      value: true,
      defaultValue: false,
      description: "Retailer: Instacart shopping-list link enabled",
    },
  });
  const after = await prisma.systemSetting.findUnique({ where: { key: INSTACART_ENABLED_SETTING_KEY } });
  console.log(`after:  ${JSON.stringify(after?.value)}   (key ${INSTACART_ENABLED_SETTING_KEY})`);
}

/** The mobile `GroceryListItem` shape the selection + pack helpers read. */
function toMobileItem(it: Record<string, any>) {
  return {
    id: it.id,
    name: it.displayName,
    quantityAmount: String(it.quantity),
    quantityUnit: it.unit || undefined,
    sectionKey: it.storeSection,
    isUniversalStaple: it.isUniversalStaple || it.isUserPantryStaple,
    stapleOptedIn: it.stapleOptedIn,
    isRecurringItem: it.isRecurringItem,
    isCompleted: it.isChecked,
    purchaseUnit: it.purchaseUnit,
    purchaseDisplay: it.purchaseDisplay,
    purchaseUnitOverride: it.purchaseUnitOverride,
    purchaseQuantityOverride: it.purchaseQuantityOverride,
    purchaseDisplayOverride: it.purchaseDisplayOverride,
    packCount: it.packCount,
    userResolvedTo: it.userResolvedTo,
  };
}

async function payload(prisma: PrismaClient, prefix: string): Promise<void> {
  const list = await prisma.groceryList.findFirst({
    where: { id: { startsWith: prefix } },
    include: { items: { where: { deletedAt: null }, orderBy: [{ storeSection: "asc" }, { displayName: "asc" }] } },
  });
  if (!list) { console.log(`### ${prefix} NOT FOUND`); return; }
  console.log(`\n### list ${list.id}  ·  ${list.items.length} live rows`);

  const mobile = list.items.map((it) => toMobileItem(it as unknown as Record<string, any>));
  const selected = O.selectInstacartRows(mobile);
  const held = O.heldBackStaples(mobile);
  const summary = O.instacartCountSummary(mobile);
  console.log(`\nselection (lib/instacartOrder.selectInstacartRows): ${selected.length} of ${mobile.length}`);
  console.log(`count line: "${summary.line}"`);
  console.log(`\nHELD BACK (${held.length}):`);
  for (const h of held) console.log(`   [${h.sectionKey}] ${h.name}`);

  const clientItems = O.instacartItemsForList(mobile);
  const rows = list.items.map((it) => {
    const r = it as unknown as Record<string, any>;
    return {
      id: it.id,
      displayName: it.displayName,
      userResolvedTo: r.userResolvedTo ?? null,
      quantity: it.quantity,
      unit: it.unit,
      purchaseUnit: it.purchaseUnit,
      purchaseQuantity: it.purchaseQuantity,
      purchaseDisplay: it.purchaseDisplay,
      purchaseUnitOverride: r.purchaseUnitOverride ?? null,
      purchaseQuantityOverride: r.purchaseQuantityOverride ?? null,
      purchaseDisplayOverride: r.purchaseDisplayOverride ?? null,
      deletedAt: it.deletedAt ?? null,
    };
  });
  const result = composeInstacartPayload(rows, clientItems, { title: INSTACART_DEFAULT_TITLE });
  console.log(`\nLINE ITEMS (${result.payload.line_items.length}):`);
  for (const li of result.payload.line_items) {
    console.log(
      `   ${String(li.quantity).padStart(6)} ${String(li.unit).padEnd(10)} ${li.name.padEnd(40)} | ${li.display_text ?? ""}`,
    );
  }
  if (result.skipped.length) console.log(`\nskipped: ${JSON.stringify(result.skipped)}`);
  if (result.unmappedUnits.length) {
    console.log(`\nunmapped units (${result.unmappedUnits.length}): ${result.unmappedUnits.map((u) => u.unit).join(", ")}`);
  }
}

// ── the REGENERATED list ───────────────────────────────────────────────────
//
// ⚠️ A PERSISTED LIST IS STALE FOR THIS PURPOSE. List 14805f6e was generated on
// September 29, before D-WS9-292 and before F2/F3/F4's catalog rows, so its
// stored `purchaseDisplay` still says "1.5 lb pack". Regenerating it would
// WRITE, which this lane does not do to a user's list. So the payload is built
// from a census run of the same plan — the real pipeline, at HEAD, stopped
// before persistence — which is exactly what the phone would be handed after the
// next generation.
function fromCorpus(tag: string): { id: string; rows: Record<string, any>[] } | null {
  const idx = JSON.parse(
    readFileSync(join(process.cwd(), "scripts", "grocery-census", "out", `_index__${tag}.json`), "utf8"),
  ) as { entries: { file: string; planId: string }[] };
  const e = idx.entries[0];
  if (!e) return null;
  const run = JSON.parse(
    readFileSync(join(process.cwd(), "scripts", "grocery-census", "out", e.file), "utf8"),
  ) as { planId: string; final: Record<string, any>[] };
  return {
    id: run.planId,
    rows: run.final.map((f, i) => ({
      id: `corpus-${i}`,
      displayName: f.displayName,
      quantity: f.quantity,
      unit: f.unit,
      storeSection: f.sectionKey,
      isChecked: false,
      isUniversalStaple: f.isUniversalStaple,
      isUserPantryStaple: f.isUserPantryStaple,
      isRecurringItem: f.isRecurringItem,
      stapleOptedIn: false,
      purchaseUnit: f.purchaseUnit,
      purchaseQuantity: f.purchaseQuantity,
      purchaseDisplay: f.purchaseDisplay,
      purchaseUnitOverride: null,
      purchaseQuantityOverride: null,
      purchaseDisplayOverride: null,
      packCount: f.packCount,
      userResolvedTo: null,
      deletedAt: null,
    })),
  };
}

function report(label: string, items: Record<string, any>[]): void {
  console.log(`\n### ${label}  ·  ${items.length} rows`);
  const mobile = items.map(toMobileItem);
  const selected = O.selectInstacartRows(mobile);
  const held = O.heldBackStaples(mobile);
  const summary = O.instacartCountSummary(mobile);
  console.log(`\nselection (lib/instacartOrder.selectInstacartRows): ${selected.length} of ${mobile.length}`);
  console.log(`count line: "${summary.line}"`);
  console.log(`\nHELD BACK (${held.length}):`);
  for (const h of held) console.log(`   [${h.sectionKey}] ${h.name}`);

  const clientItems = O.instacartItemsForList(mobile);
  const rows = items.map((it) => ({
    id: it.id,
    displayName: it.displayName,
    userResolvedTo: it.userResolvedTo ?? null,
    quantity: it.quantity,
    unit: it.unit,
    purchaseUnit: it.purchaseUnit,
    purchaseQuantity: it.purchaseQuantity,
    purchaseDisplay: it.purchaseDisplay,
    purchaseUnitOverride: it.purchaseUnitOverride ?? null,
    purchaseQuantityOverride: it.purchaseQuantityOverride ?? null,
    purchaseDisplayOverride: it.purchaseDisplayOverride ?? null,
    deletedAt: it.deletedAt ?? null,
  }));
  const result = composeInstacartPayload(rows, clientItems, { title: INSTACART_DEFAULT_TITLE });
  console.log(`\nLINE ITEMS (${result.payload.line_items.length}):`);
  for (const li of result.payload.line_items) {
    console.log(
      `   ${String(li.quantity).padStart(7)} ${String(li.unit).padEnd(10)} ${li.name.padEnd(42)} | ${li.display_text ?? ""}`,
    );
  }
  if (result.skipped.length) console.log(`\nskipped: ${JSON.stringify(result.skipped)}`);
  if (result.unmappedUnits.length) {
    console.log(`\nunmapped units (${result.unmappedUnits.length}): ${[...new Set(result.unmappedUnits.map((u) => u.unit))].join(", ")}`);
  }
}

async function main() {
  assertDevHost();
  reportCredentials();
  const prisma = new PrismaClient();
  if (process.argv.includes("--enable")) {
    await enable(prisma);
  }
  const ci = process.argv.indexOf("--corpus");
  if (ci >= 0 && process.argv[ci + 1]) {
    const c = fromCorpus(process.argv[ci + 1]);
    if (c) report(`REGENERATED at HEAD — plan ${c.id}  (census tag ${process.argv[ci + 1]})`, c.rows);
  }
  // Bare arguments are LIST id prefixes. The value after `--corpus` is a census
  // tag, not a list, so it is skipped by position rather than by pattern — a
  // tag and a list prefix are both short hex-ish strings and no regex separates
  // them honestly.
  const bare = process.argv
    .slice(2)
    .filter((x, i) => !x.startsWith("--") && process.argv[i + 1] !== "--corpus");
  for (const prefix of bare) {
    await payload(prisma, prefix);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
