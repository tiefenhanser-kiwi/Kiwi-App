// WS9 BUG-134 — duplicate grocery-bucket BACKFILL.
//
// WHAT: collapses the duplicate `(groceryListId, ingredientId, unit)` buckets
// that BUG-096's merge already created, using the same semantics the guard now
// applies going forward (ws9-bug096-ingredient-merge.ts / planGroceryBucketMerges).
//
// ── HOW THEY GOT THERE ──────────────────────────────────────────────────────
// BUG-096 repointed every GroceryListItem from a loser ingredient id to its
// survivor with a bare `updateMany` and never looked at the destination. A list
// already holding a survivor-side row in the same unit therefore ended up with
// two rows for one ingredient. Measured: 8 groups across 6 lists. The rows wear
// the merge's own review-sheet packs — one the survivor's, one the loser's
// (`13 cloves (1–2 bulbs)` beside `1 head of garlic`, `2 limes` beside
// `3 limes`, `4 roma tomatoes` beside `7 roma tomatoes`) — which is how the
// mechanism was identified. Lists created after that run show zero duplicates.
//
// ── MERGE SEMANTICS (ruled) ─────────────────────────────────────────────────
//   quantity : SUM. Both rows carry real, DISJOINT sources — no (mealId, dishId)
//              pair is shared by the two rows of any group, verified — so the
//              sum is exactly what the consolidator would have produced had they
//              bucketed together. Independent corroboration: list c6ff50af's two
//              roma rows are 3 and 6, and BUG-125's recorded observation for that
//              list is "a need of 9". A max would under-order, the ruled-worst
//              failure class on this surface.
//   sources  : UNION onto the keeper. A (mealId, dishId) the keeper already holds
//              is one source, not two, so a colliding copy is dropped and counted
//              (the PrepStepCompletion precedent from the merge script).
//   pack     : the KEEPER's stored pack, untouched. Nothing here recomputes or
//              re-resolves a pack — that is BUG-137's separate backfill, and
//              conflating them makes both unverifiable.
//   the emptied row is DELETED.
//
// ── WHICH ROW KEEPS ─────────────────────────────────────────────────────────
// Both rows already point at the survivor id, so "survivor-side" is no longer
// readable from the data. The rule, in order:
//   1. the row whose pack fields equal the Ingredient row's CURRENT pack — that
//      is the pack BUG-096's reviewed sheet installed, so the surviving line
//      agrees with the catalog. For `garlic cloves` the sheet's decision was
//      LOSER, so this deliberately keeps the loser-side pack: honouring the
//      review beats reconstructing provenance.
//   2. else the row with more sources.
//   3. else the lexicographically lower id, for determinism.
// The choice is written into the sheet as `keep_row_id` and the apply pass reads
// it back, so any row can be overridden by editing that cell.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// GENERATED rows only (`isUserAdded = false`, `deletedAt IS NULL`). A bucket
// containing a user-added row is EXCLUDED and reported, never fixed: Extras and
// recurring items are separate rows the user added deliberately, so that bucket
// is legal (ruled) and its mechanism is a different one — the add route at
// groceryLists.ts is a bare `create` with no bucket lookup. Archived and active
// lists are both in scope; a duplicate row is wrong regardless of list state.
//
// IDEMPOTENT: a sheet row whose absorb id is already gone is skipped and counted.
//
// Run (from artifacts/api-server):
//   DRY-RUN: node --env-file=.env --import tsx scripts/ws9-bug134-dup-bucket-backfill.ts
//   APPLY:   node --env-file=.env --import tsx scripts/ws9-bug134-dup-bucket-backfill.ts \
//              --apply --sheet scripts/output/bug134-dupmerge-<ts>.csv

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

// ── CSV helpers (mirrors ws9-bug096-ingredient-merge.ts) ────────────────────

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}
/** Minimal RFC-4180 row splitter — handles quoted cells containing commas. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (c === "\r") continue;
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── the scan ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  groceryListId: string;
  ingredientId: string;
  unit: string;
  quantity: number;
  displayName: string;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  isUserAdded: boolean;
  sources: number;
}

interface Bucket {
  key: string;
  groceryListId: string;
  listTitle: string;
  listStatus: string;
  ingredientId: string;
  ingredientName: string;
  unit: string;
  rows: Row[];
  /** the Ingredient row's CURRENT pack, for the keep rule */
  catalogPack: { unit: string | null; quantity: number | null; display: string | null };
}

/**
 * Rank two rows for the keep decision. Lower sorts first = keeps.
 * See the header block for the ordering and why (1) beats provenance.
 */
function keepRank(r: Row, b: Bucket): [number, number, string] {
  const matchesCatalog =
    r.purchaseDisplay === b.catalogPack.display &&
    r.purchaseUnit === b.catalogPack.unit &&
    r.purchaseQuantity === b.catalogPack.quantity;
  return [matchesCatalog ? 0 : 1, -r.sources, r.id];
}

function chooseKeeper(b: Bucket): Row {
  return b.rows
    .slice()
    .sort((x, y) => {
      const a = keepRank(x, b);
      const c = keepRank(y, b);
      if (a[0] !== c[0]) return a[0] - c[0];
      if (a[1] !== c[1]) return a[1] - c[1];
      return a[2] < c[2] ? -1 : a[2] > c[2] ? 1 : 0;
    })[0]!;
}

async function scanBuckets(): Promise<{ generated: Bucket[]; userAddedSkipped: Bucket[] }> {
  // Every duplicate bucket, INCLUDING those containing a user-added row, so the
  // excluded ones can be reported rather than silently missing from the sheet.
  const dupKeys = await prisma.$queryRaw<
    Array<{ groceryListId: string; ingredientId: string; unit: string }>
  >`
    SELECT "groceryListId", "ingredientId", unit
    FROM grocery_list_items
    WHERE "deletedAt" IS NULL AND "ingredientId" IS NOT NULL
    GROUP BY "groceryListId", "ingredientId", unit
    HAVING COUNT(*) > 1
  `;
  if (dupKeys.length === 0) return { generated: [], userAddedSkipped: [] };

  const listIds = [...new Set(dupKeys.map((k) => k.groceryListId))];
  const ingIds = [...new Set(dupKeys.map((k) => k.ingredientId))];

  const items = await prisma.groceryListItem.findMany({
    where: { deletedAt: null, groceryListId: { in: listIds }, ingredientId: { in: ingIds } },
    select: {
      id: true, groceryListId: true, ingredientId: true, unit: true, quantity: true,
      displayName: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
      isUserAdded: true,
      _count: { select: { sources: true } },
    },
  });
  const lists = new Map(
    (await prisma.groceryList.findMany({
      where: { id: { in: listIds } },
      select: { id: true, title: true, status: true },
    })).map((l) => [l.id, l]),
  );
  const ings = new Map(
    (await prisma.ingredient.findMany({
      where: { id: { in: ingIds } },
      select: { id: true, canonicalName: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true },
    })).map((i) => [i.id, i]),
  );

  const wanted = new Set(dupKeys.map((k) => `${k.groceryListId}|${k.ingredientId}|${k.unit}`));
  const byKey = new Map<string, Bucket>();
  for (const it of items) {
    if (it.ingredientId === null) continue;
    const key = `${it.groceryListId}|${it.ingredientId}|${it.unit}`;
    if (!wanted.has(key)) continue;
    let b = byKey.get(key);
    if (!b) {
      const list = lists.get(it.groceryListId);
      const ing = ings.get(it.ingredientId);
      b = {
        key,
        groceryListId: it.groceryListId,
        listTitle: list?.title ?? "",
        listStatus: String(list?.status ?? ""),
        ingredientId: it.ingredientId,
        ingredientName: ing?.canonicalName ?? "(unknown)",
        unit: it.unit,
        rows: [],
        catalogPack: {
          unit: ing?.purchaseUnit ?? null,
          quantity: ing?.purchaseQuantity ?? null,
          display: ing?.purchaseDisplay ?? null,
        },
      };
      byKey.set(key, b);
    }
    b.rows.push({
      id: it.id,
      groceryListId: it.groceryListId,
      ingredientId: it.ingredientId,
      unit: it.unit,
      quantity: it.quantity,
      displayName: it.displayName,
      purchaseUnit: it.purchaseUnit,
      purchaseQuantity: it.purchaseQuantity,
      purchaseDisplay: it.purchaseDisplay,
      isUserAdded: it.isUserAdded,
      sources: it._count.sources,
    });
  }

  const generated: Bucket[] = [];
  const userAddedSkipped: Bucket[] = [];
  for (const b of byKey.values()) {
    b.rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (b.rows.some((r) => r.isUserAdded)) userAddedSkipped.push(b);
    else generated.push(b);
  }
  const byName = (x: Bucket, y: Bucket) =>
    x.ingredientName.localeCompare(y.ingredientName) || x.groceryListId.localeCompare(y.groceryListId);
  generated.sort(byName);
  userAddedSkipped.sort(byName);
  return { generated, userAddedSkipped };
}

const SHEET_HEADER = [
  "decision", "ingredient", "unit", "list_id", "list_status", "list_title",
  "keep_row_id", "keep_qty", "keep_pack", "keep_sources",
  "absorb_row_id", "absorb_qty", "absorb_pack", "absorb_sources",
  "merged_qty", "catalog_pack",
];

function buildSheet(buckets: Bucket[]): { path: string; rows: number } {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `bug134-dupmerge-${timestamp()}.csv`);
  const lines: string[] = [csvLine(SHEET_HEADER)];
  let count = 0;
  for (const b of buckets) {
    const keeper = chooseKeeper(b);
    const total = b.rows.reduce((s, r) => s + r.quantity, 0);
    for (const r of b.rows) {
      if (r.id === keeper.id) continue;
      lines.push(csvLine([
        "MERGE", b.ingredientName, b.unit, b.groceryListId, b.listStatus, b.listTitle,
        keeper.id, keeper.quantity, keeper.purchaseDisplay, keeper.sources,
        r.id, r.quantity, r.purchaseDisplay, r.sources,
        total, b.catalogPack.display,
      ]));
      count++;
    }
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { path, rows: count };
}

// ── apply ───────────────────────────────────────────────────────────────────

interface SheetRow {
  decision: string;
  keepId: string;
  absorbId: string;
  mergedQty: number;
  label: string;
}

function readSheet(path: string): SheetRow[] {
  return parseCsv(readFileSync(path, "utf8")).map((r) => ({
    decision: (r.decision ?? "").toUpperCase(),
    keepId: r.keep_row_id ?? "",
    absorbId: r.absorb_row_id ?? "",
    mergedQty: Number(r.merged_qty),
    label: `${r.ingredient ?? "?"} [${r.unit ?? "?"}] list ${(r.list_id ?? "").slice(0, 8)}`,
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const sheetPath = argv[argv.indexOf("--sheet") + 1];

  console.log(`\n=== WS9 BUG-134 duplicate-bucket backfill (${apply ? "APPLY" : "DRY-RUN"}) ===\n`);

  const { generated, userAddedSkipped } = await scanBuckets();
  console.log(`  duplicate buckets, GENERATED only : ${generated.length}`);
  console.log(`  duplicate buckets EXCLUDED (user-added present, ruled legal): ${userAddedSkipped.length}`);
  for (const b of userAddedSkipped) {
    console.log(`     - ${b.ingredientName} [${b.unit}] list ${b.groceryListId.slice(0, 8)} — rows: ${b.rows
      .map((r) => `${r.id.slice(0, 8)}(qty ${r.quantity}${r.isUserAdded ? ", USER-ADDED" : ""})`)
      .join(" + ")}`);
  }

  for (const b of generated) {
    const keeper = chooseKeeper(b);
    const total = b.rows.reduce((s, r) => s + r.quantity, 0);
    console.log(`\n  ${b.ingredientName} [${b.unit}]  list ${b.groceryListId.slice(0, 8)} (${b.listStatus})`);
    for (const r of b.rows) {
      console.log(`     ${r.id === keeper.id ? "KEEP  " : "absorb"} ${r.id.slice(0, 8)}  qty=${r.quantity}  sources=${r.sources}  pack=${JSON.stringify(r.purchaseDisplay)}`);
    }
    console.log(`     -> merged qty ${total}, pack stays ${JSON.stringify(keeper.purchaseDisplay)} (catalog: ${JSON.stringify(b.catalogPack.display)})`);
  }

  if (!apply) {
    if (generated.length === 0) {
      console.log(`\n  Nothing to do — no generated duplicate buckets. (idempotent)\n`);
      return;
    }
    const sheet = buildSheet(generated);
    console.log(`\n--- review sheet ---`);
    console.log(`  ${sheet.rows} merge(s) -> ${sheet.path}`);
    console.log(`\nDRY-RUN — nothing written. Review the sheet (set a row's`);
    console.log(`\`decision\` to SKIP to leave that bucket alone, or edit \`keep_row_id\``);
    console.log(`to keep the other row), then re-run with:`);
    console.log(`  --apply --sheet <csv>\n`);
    return;
  }

  if (!sheetPath) {
    console.log(`\n  ABORT: --apply requires --sheet <csv>. Nothing written.\n`);
    process.exitCode = 1;
    return;
  }
  const sheet = readSheet(sheetPath);
  for (const r of sheet) {
    if (r.decision !== "MERGE" && r.decision !== "SKIP") {
      console.log(`\n  ABORT: sheet row "${r.label}" has decision "${r.decision}". Allowed: MERGE | SKIP.\n`);
      process.exitCode = 1;
      return;
    }
    if (r.decision === "MERGE" && !Number.isFinite(r.mergedQty)) {
      console.log(`\n  ABORT: sheet row "${r.label}" has a non-numeric merged_qty.\n`);
      process.exitCode = 1;
      return;
    }
  }
  const todo = sheet.filter((r) => r.decision === "MERGE");
  console.log(`\n  sheet: ${sheet.length} row(s), ${todo.length} MERGE, ${sheet.length - todo.length} SKIP`);

  const live = new Set(
    (await prisma.groceryListItem.findMany({
      where: { id: { in: [...new Set(todo.flatMap((r) => [r.keepId, r.absorbId]))] } },
      select: { id: true },
    })).map((r) => r.id),
  );

  let merged = 0, srcMoved = 0, srcDropped = 0, alreadyDone = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of todo) {
      // Idempotence: a second --apply finds the absorbed row already gone.
      if (!live.has(r.absorbId)) { alreadyDone++; continue; }
      if (!live.has(r.keepId)) {
        throw new Error(`keep_row_id ${r.keepId} does not exist (${r.label}) — refusing to guess`);
      }
      const keeperSrc = await tx.groceryListItemSource.findMany({
        where: { groceryListItemId: r.keepId },
        select: { mealId: true, dishId: true },
      });
      const held = new Set(keeperSrc.map((s) => `${s.mealId}|${s.dishId}`));
      const absorbSrc = await tx.groceryListItemSource.findMany({
        where: { groceryListItemId: r.absorbId },
        select: { id: true, mealId: true, dishId: true },
      });
      const drop: string[] = [];
      for (const s of absorbSrc) {
        const pair = `${s.mealId}|${s.dishId}`;
        if (held.has(pair)) { drop.push(s.id); continue; }
        held.add(pair);
        // Move BEFORE the delete: sources cascade on item delete.
        await tx.groceryListItemSource.update({
          where: { id: s.id },
          data: { groceryListItemId: r.keepId },
        });
        srcMoved++;
      }
      if (drop.length > 0) {
        srcDropped += (await tx.groceryListItemSource.deleteMany({ where: { id: { in: drop } } })).count;
      }
      await tx.groceryListItem.update({ where: { id: r.keepId }, data: { quantity: r.mergedQty } });
      await tx.groceryListItem.delete({ where: { id: r.absorbId } });
      merged++;
    }
  }, { timeout: 60_000, maxWait: 15_000 });

  console.log(`\n--- applied ---`);
  console.log(`  buckets merged                  : ${merged}`);
  console.log(`  already merged (idempotent skip): ${alreadyDone}`);
  console.log(`  sources moved / dropped as dup  : ${srcMoved} / ${srcDropped}`);

  // ── post-apply assertion, same scope as the merge script's ────────────────
  const after = await prisma.$queryRaw<
    Array<{ groceryListId: string; ingredientId: string; unit: string; n: bigint }>
  >`
    SELECT "groceryListId", "ingredientId", unit, COUNT(*) AS n
    FROM grocery_list_items
    WHERE "deletedAt" IS NULL AND "ingredientId" IS NOT NULL AND "isUserAdded" = false
    GROUP BY "groceryListId", "ingredientId", unit
    HAVING COUNT(*) > 1
  `;
  console.log(`\n--- BUG-134 duplicate-bucket assertion ---`);
  if (after.length === 0) {
    console.log(`  PASS — 0 generated (list, ingredient, unit) buckets hold >1 row.`);
  } else {
    console.log(`  FAIL — ${after.length} generated bucket(s) still hold more than one row:`);
    for (const b of after) {
      console.log(`     list ${b.groceryListId} ingredient ${b.ingredientId} [${b.unit}] x${Number(b.n)}`);
    }
    process.exitCode = 1;
    return;
  }

  // Orphan check: GroceryListItemSource cascades on item delete, so a source
  // that failed to move would be GONE, not dangling. Count what remains against
  // the keepers so the sheet's claim is checkable after the fact.
  const orphan = await prisma.groceryListItemSource.count({
    where: { groceryListItemId: { in: todo.map((r) => r.absorbId) } },
  });
  console.log(`  source rows still pointing at an absorbed item (expect 0): ${orphan}`);
  if (orphan !== 0) process.exitCode = 1;
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
