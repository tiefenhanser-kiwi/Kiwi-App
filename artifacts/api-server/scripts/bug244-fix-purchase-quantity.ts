// BUG-244 — the 15 Class-B rows store a pack COUNT in a column that means pack
// SIZE, so a one-can need ships two cans.
//
// Hans ruled September 9: "They're all individually purchaseable. no packs."
// → all 15 get purchaseQuantity = 1. Nothing else in the catalog moves.
//
// ── SEPTEMBER 11: THE DISPLAY TEXT TOO ────────────────────────────────────
// The quantity write above changed the arithmetic and NOT the screen. The
// client's composePackName never reads purchaseQuantity — packLeadingQuantity
// reads the pack count off the FRONT of purchaseDisplay, and scalePackDisplay
// returns the stored string untouched at packs <= 1. Run against the real
// composer: a 15 oz need with "2 cans (15 oz each)" still renders
// "2 cans (15 oz each) canned black beans"; with "1 can (15 oz)" it renders
// "1 can (15 oz) canned black beans" (and 45 oz goes 4 cans → 3 cans). So the
// same 15 rows also get purchaseDisplay = "1 <purchaseUnit> (<amount>)" — the
// curated `black beans` form, "each" dropped, the amount lifted verbatim from
// the string that is already there. purchaseUnit is the singular noun on every
// one of the 15 ("can" / "jar"), which is why it, and not a de-pluraliser, is
// the source of the word.
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
// after-hash. Verification is: after-hash === before-hash (the 92 untouched,
// quantity AND display) AND all 15 read 1 AND all 15 display "1 <unit> (…)".
//
// Idempotent: the assertion accepts EITHER the pre-fix text ("2 cans (15 oz
// each)") or the exact post-fix text ("1 can (15 oz)") for each of the 15, so
// a re-run after apply reports 0 writes; any third shape still refuses.
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
//
// Two hashes, not one: `hash` is the September 9 quantity hash (794bf39c…),
// kept byte-identical so it stays comparable with that run; `displayHash` is
// the same 92 rows' purchaseDisplay, added now that this script writes display.
async function classAHash(): Promise<{ hash: string; displayHash: string; n: number }> {
  const rows = await prisma.ingredient.findMany({
    where: { purchaseQuantity: { gt: 1 }, id: { notIn: FROZEN_IDS } },
    select: { id: true, purchaseQuantity: true, purchaseDisplay: true },
    orderBy: { id: "asc" },
  });
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  return {
    hash: sha(rows.map((r) => `${r.id}:${r.purchaseQuantity}`).join("\n")),
    displayHash: sha(rows.map((r) => `${r.id}:${r.purchaseDisplay}`).join("\n")),
    n: rows.length,
  };
}

// The pre-fix shape: "<N> <plural noun> (<amount> each)". The amount is
// whatever sits between "(" and " each)" — "15 oz", "14.5 oz", "10 oz",
// "28 oz", "16 oz" — lifted verbatim, never re-formatted.
const PRE_FIX = /^\s*[\d.]+\s+\S+\s+\((.+?)\s+each\)\s*$/i;

// The post-fix string for a row: "1 <purchaseUnit> (<amount>)". Null when the
// row's display is neither the pre-fix shape nor already the post-fix one —
// that is the drift the assertion refuses on.
function targetDisplay(row: { purchaseUnit: string | null; purchaseDisplay: string | null }): string | null {
  if (!row.purchaseUnit || !row.purchaseDisplay) return null;
  const unit = row.purchaseUnit.trim();
  const m = PRE_FIX.exec(row.purchaseDisplay);
  if (m) return `1 ${unit} (${m[1]})`;
  // Already written by a previous --apply: accept ONLY the exact form this
  // script would have produced ("1 can (15 oz)"), so the re-run is a no-op.
  const done = new RegExp(`^1 ${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([^()]+\\)$`);
  return done.test(row.purchaseDisplay) ? row.purchaseDisplay : null;
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
  // Pre-fix ("… each") or exactly post-fix ("1 <unit> (…)"); a third shape is
  // drift and refuses the run. This subsumes the original `\beach\b` check.
  if (targetDisplay(row) === null) {
    problems.push(`${row.canonicalName}: purchaseDisplay is neither the "each" form nor "1 ${row.purchaseUnit} (…)" — ${JSON.stringify(row.purchaseDisplay)}. The Class-B discriminator no longer holds.`);
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
console.log(`\nCLASS-A (untouched set) BEFORE: n=${beforeHash.n} qty-sha256=${beforeHash.hash}`);
console.log(`                                     display-sha256=${beforeHash.displayHash}`);

console.log(`\n${"".padEnd(118, "─")}`);
console.log(`${"name".padEnd(34)} ${"purchaseDisplay".padEnd(26)} ${"qty".padStart(4)}    action`);
console.log(`${"".padEnd(118, "─")}`);
// One write per row that needs EITHER column; both columns are set in the same
// UPDATE so a row can never land half-fixed.
const toWrite: { id: string; display: string }[] = [];
for (const f of FROZEN) {
  const r = before.get(f.id)!;
  const display = targetDisplay(r)!; // non-null: the assertion above proved it
  const qtyDone = r.purchaseQuantity === 1;
  const displayDone = r.purchaseDisplay === display;
  if (!qtyDone || !displayDone) toWrite.push({ id: f.id, display });
  const action =
    qtyDone && displayDone
      ? "already 1 + display done (skipped)"
      : `${qtyDone ? "qty already 1" : "qty → 1"}; display → "${display}"${displayDone ? " (already)" : ""}`;
  console.log(
    `${r.canonicalName.padEnd(34)} ${(r.purchaseDisplay ?? "").padEnd(26)} ${String(r.purchaseQuantity).padStart(4)} → ${action}`,
  );
}
console.log(`${"".padEnd(118, "─")}`);
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
    toWrite.map(({ id, display }) =>
      prisma.ingredient.update({
        where: { id },
        data: { purchaseQuantity: 1, purchaseDisplay: display },
      }),
    ),
  );
  console.log(`\n✅ wrote ${toWrite.length} row(s) in one transaction.`);
}

// ── verification, from a FRESH read ───────────────────────────────────────
const after = await readFrozen();
console.log(`\nAFTER (fresh read):`);
console.log(`${"".padEnd(104, "─")}`);
let allOne = true;
let allDisplayOne = true;
for (const f of FROZEN) {
  const r = after.get(f.id)!;
  if (r.purchaseQuantity !== 1) allOne = false;
  // The post-fix form and nothing else. targetDisplay returns the row's own
  // string only when it already IS "1 <purchaseUnit> (<amount>)"; a still-
  // pre-fix row yields the derived target, which differs from what is stored.
  if (targetDisplay(r) !== r.purchaseDisplay) allDisplayOne = false;
  console.log(
    `${r.canonicalName.padEnd(34)} ${(r.purchaseDisplay ?? "").padEnd(26)} ${String(r.purchaseQuantity).padStart(4)}`,
  );
}
console.log(`${"".padEnd(104, "─")}`);
const afterHash = await classAHash();
console.log(`\nCLASS-A (untouched set) AFTER : n=${afterHash.n} qty-sha256=${afterHash.hash}`);
console.log(`                                     display-sha256=${afterHash.displayHash}`);
console.log(`\nVERIFICATION`);
console.log(`  all ${FROZEN.length} read 1                : ${allOne ? "YES" : "🔴 NO"}`);
console.log(`  all ${FROZEN.length} display 1 <unit>      : ${allDisplayOne ? "YES" : "🔴 NO"}`);
console.log(`  Class-A qty hash unchanged   : ${afterHash.hash === beforeHash.hash ? "YES" : "🔴 NO"}`);
console.log(`  Class-A display hash unchanged: ${afterHash.displayHash === beforeHash.displayHash ? "YES" : "🔴 NO"}`);
console.log(`  Class-A row count unchanged  : ${afterHash.n === beforeHash.n ? `YES (${afterHash.n})` : `🔴 NO (${beforeHash.n} → ${afterHash.n})`}`);
if (
  !allOne ||
  !allDisplayOne ||
  afterHash.hash !== beforeHash.hash ||
  afterHash.displayHash !== beforeHash.displayHash ||
  afterHash.n !== beforeHash.n
) {
  console.error(`\n🔴 VERIFICATION FAILED — inspect before trusting this run.`);
  await prisma.$disconnect();
  process.exit(3);
}
console.log(`\n✅ verified.`);
await prisma.$disconnect();
