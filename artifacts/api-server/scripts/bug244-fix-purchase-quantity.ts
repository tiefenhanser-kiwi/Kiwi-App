// BUG-244 — the 15 Class-B rows store a pack COUNT in a column that means pack
// SIZE, so a one-can need ships two cans.
//
// Hans ruled September 9: "They're all individually purchaseable. no packs."
// → all 15 get purchaseQuantity = 1. Nothing else in the catalog moves.
//
// THE DISCRIMINATOR IS "each", NOT "can". The word "each" in a purchaseDisplay
// is what makes the parenthesised size PER-UNIT and the leading number a
// MULTIPLIER — "3 jars (16 oz each)" is three jars of 16 oz, not one 48 oz jar.
// "can" was a proxy for it and missed `chunky salsa` (purchaseUnit "jar"),
// which is why the first census held 14. Widened here and re-verified: the
// "each" form finds exactly these 15 across the 107 rows with
// purchaseQuantity > 1, and no sixteenth.
//
// ── WHY THE IDS ARE FROZEN HERE RATHER THAN RE-QUERIED ────────────────────
// Re-running the discriminator at apply time would let the SET drift between
// what Hans ruled on and what gets written. The census he ruled on is the
// authority, so it is a literal below; the discriminator is re-checked only as
// an ASSERTION, and any row that no longer matches aborts the WHOLE run rather
// than being skipped. A partial write on a moved catalog is the failure mode
// worth refusing.
//
// ── USAGE ─────────────────────────────────────────────────────────────────
//   node --env-file=.env --import tsx scripts/bug244-fix-purchase-quantity.ts
//   node --env-file=.env --import tsx scripts/bug244-fix-purchase-quantity.ts --apply
//
// Dry-run is the default and prints the before-hash of the 92 Class-A rows.
// --apply writes in ONE transaction and re-prints from a FRESH read plus the
// after-hash. Verification is: after-hash === before-hash (the 92 untouched)
// AND all 15 read 1.
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
console.log("DB HOST =", new URL(process.env.DATABASE_URL!).host);
console.log(`MODE    = ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);

// The census Hans ruled on. DO NOT regenerate this list.
const FROZEN: { id: string; name: string }[] = [
  { id: "465709f9-c999-4a56-a826-d352cbaab93b", name: "beef broth" },
  { id: "4efd3dd1-7fa6-42b1-bfe4-7ea5793701b5", name: "canned black beans" },
  { id: "f9cce446-5775-4af8-9969-e648930f9824", name: "canned cannellini beans" },
  { id: "368434b4-8369-4b7a-9b1a-01e75b32c79f", name: "canned mild red enchilada sauce" },
  { id: "1a124335-8fa4-4b90-8730-3f77cec670df", name: "canned navy beans" },
  { id: "6dddf4f5-406f-451c-9d5e-cfea6e904e51", name: "canned pinto beans" },
  { id: "bd2fece7-ba5f-4b4f-b110-85fcd7e7b62b", name: "canned refried beans" },
  { id: "230b457f-56c6-45b8-8e85-2a8514f53310", name: "canned white cannellini beans" },
  { id: "f3287ad9-32a4-4a9b-b701-0faa71228100", name: "chicken broth" },
  // Ruled separately, September 10: "chunky salsa is purchased 1 jar at a time."
  // The only member found by the "each" discriminator but NOT by "can" — which
  // is why the census Hans first saw held 14 and this one holds 15.
  { id: "22a31385-0229-4444-891b-13e01edfb0fe", name: "chunky salsa" },
  { id: "24646a9c-f8ea-476b-b3cc-c2373d93870a", name: "dark red kidney beans" },
  { id: "7e3ac570-a911-47cb-8e74-deba619258e5", name: "low-sodium chicken broth" },
  { id: "cf1cf761-d757-463e-bf8f-7ba69970204d", name: "mild red enchilada sauce" },
  { id: "296755c4-bde3-4aa1-bb69-fce1b9e502d1", name: "navy beans" },
  { id: "231654bd-67d0-41a9-aad3-f29c538c2734", name: "whole san marzano tomatoes" },
];
const FROZEN_IDS = FROZEN.map((f) => f.id);

// The untouched set: everything ELSE that carries purchaseQuantity > 1. Defined
// identically before and after, because the 15 fall out of `> 1` once written —
// so the same query names the same 92 rows on both sides of the apply.
async function classAHash(): Promise<{ hash: string; n: number }> {
  const rows = await prisma.ingredient.findMany({
    where: { purchaseQuantity: { gt: 1 }, id: { notIn: FROZEN_IDS } },
    select: { id: true, purchaseQuantity: true },
    orderBy: { id: "asc" },
  });
  const payload = rows.map((r) => `${r.id}:${r.purchaseQuantity}`).join("\n");
  return { hash: crypto.createHash("sha256").update(payload).digest("hex"), n: rows.length };
}

async function readFrozen() {
  const rows = await prisma.ingredient.findMany({
    where: { id: { in: FROZEN_IDS } },
    select: { id: true, canonicalName: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

// ── the assertion, run BEFORE anything ────────────────────────────────────
const before = await readFrozen();
const problems: string[] = [];
for (const f of FROZEN) {
  const row = before.get(f.id);
  if (!row) { problems.push(`${f.name} (${f.id}): ROW NO LONGER EXISTS`); continue; }
  if (row.canonicalName !== f.name) {
    problems.push(`${f.id}: name moved — census said "${f.name}", catalog says "${row.canonicalName}"`);
  }
  if (!/\beach\b/i.test(row.purchaseDisplay ?? "")) {
    problems.push(`${row.canonicalName}: purchaseDisplay no longer carries "each" — ${JSON.stringify(row.purchaseDisplay)}. The Class-B discriminator no longer holds.`);
  }
  if (row.purchaseQuantity == null) {
    problems.push(`${row.canonicalName}: purchaseQuantity is NULL — not the census shape`);
  }
}
if (problems.length > 0) {
  console.error(`\n🔴 REFUSING THE WHOLE RUN — ${problems.length} row(s) no longer match the census Hans ruled on:`);
  for (const p of problems) console.error(`   - ${p}`);
  console.error(`\nNothing was written. Re-census and get a fresh ruling before running this again.`);
  await prisma.$disconnect();
  process.exit(2);
}
console.log(`\n✅ assertion passed: all ${FROZEN.length} rows still match the census.`);

const beforeHash = await classAHash();
console.log(`\nCLASS-A (untouched set) BEFORE: n=${beforeHash.n} sha256=${beforeHash.hash}`);

console.log(`\n${"".padEnd(104, "─")}`);
console.log(`${"name".padEnd(34)} ${"purchaseDisplay".padEnd(26)} ${"qty".padStart(4)}    action`);
console.log(`${"".padEnd(104, "─")}`);
const toWrite: string[] = [];
for (const f of FROZEN) {
  const r = before.get(f.id)!;
  const already = r.purchaseQuantity === 1;
  if (!already) toWrite.push(f.id);
  console.log(
    `${r.canonicalName.padEnd(34)} ${(r.purchaseDisplay ?? "").padEnd(26)} ${String(r.purchaseQuantity).padStart(4)} → ${already ? "already 1 (skipped)" : "1"}`,
  );
}
console.log(`${"".padEnd(104, "─")}`);
console.log(`rows needing a write: ${toWrite.length} of ${FROZEN.length}`);

if (!APPLY) {
  console.log(`\nDRY-RUN — nothing written. Re-run with --apply to write.`);
  await prisma.$disconnect();
  process.exit(0);
}

// ── apply: one transaction, only the rows that need it ────────────────────
if (toWrite.length === 0) {
  console.log(`\nNothing to do — already idempotent.`);
} else {
  await prisma.$transaction(
    toWrite.map((id) =>
      prisma.ingredient.update({ where: { id }, data: { purchaseQuantity: 1 } }),
    ),
  );
  console.log(`\n✅ wrote ${toWrite.length} row(s) in one transaction.`);
}

// ── verification, from a FRESH read ───────────────────────────────────────
const after = await readFrozen();
console.log(`\nAFTER (fresh read):`);
console.log(`${"".padEnd(104, "─")}`);
let allOne = true;
for (const f of FROZEN) {
  const r = after.get(f.id)!;
  if (r.purchaseQuantity !== 1) allOne = false;
  console.log(
    `${r.canonicalName.padEnd(34)} ${(r.purchaseDisplay ?? "").padEnd(26)} ${String(r.purchaseQuantity).padStart(4)}`,
  );
}
console.log(`${"".padEnd(104, "─")}`);
const afterHash = await classAHash();
console.log(`\nCLASS-A (untouched set) AFTER : n=${afterHash.n} sha256=${afterHash.hash}`);
console.log(`\nVERIFICATION`);
console.log(`  all ${FROZEN.length} read 1                : ${allOne ? "YES" : "🔴 NO"}`);
console.log(`  Class-A hash unchanged       : ${afterHash.hash === beforeHash.hash ? "YES" : "🔴 NO"}`);
console.log(`  Class-A row count unchanged  : ${afterHash.n === beforeHash.n ? `YES (${afterHash.n})` : `🔴 NO (${beforeHash.n} → ${afterHash.n})`}`);
if (!allOne || afterHash.hash !== beforeHash.hash || afterHash.n !== beforeHash.n) {
  console.error(`\n🔴 VERIFICATION FAILED — inspect before trusting this run.`);
  await prisma.$disconnect();
  process.exit(3);
}
console.log(`\n✅ verified.`);
await prisma.$disconnect();
