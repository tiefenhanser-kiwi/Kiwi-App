// CAT-Q1 — undo an apply.ts run. A DRY RUN unless --apply.
//
// Per meal, one transaction: the row graph must still hash to the post-image
// the apply recorded (else someone wrote since — skipped and reported, never
// overwritten); the pre-image is restored (graph.restoreGraph — differing rows
// updated with every column, updatedAt included; lines the apply added deleted,
// lines it removed re-created with their ids); the graph must then hash to the
// pre-image, or the transaction throws and nothing is written.
//
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/revert.ts --file out/<mode>/revert-<part>-<stamp>.json [--ids a,b] [--apply]
import { Prisma, PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { graphHash, readGraph, restoreGraph, reviveGraph, type MealGraph } from "./graph";
import { OUT } from "./issues";

const has = (k: string) => process.argv.includes(k);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const FILE = arg("--file", "");
if (!FILE) throw new Error("--file <revert file>");
const APPLY = has("--apply");
const { host, mode } = assertScriptDatabase("cat-q1/revert");
// as given (absolute or from the working directory), else a name under out/<mode>/
const path = existsSync(resolve(FILE)) ? resolve(FILE) : join(OUT, mode, FILE);
const file = JSON.parse(readFileSync(path, "utf8")) as { part: string; mode: string; host: string; meals: Array<{ mealId: string; title: string; preHash: string; postHash: string; pre: MealGraph }> };
if (file.mode !== mode || file.host !== host) throw new Error(`the revert file is for ${file.host} (${file.mode}), not ${host}: refusing`);
const only = has("--ids") ? new Set(arg("--ids", "").split(",")) : null;
console.log(`database: ${host} (${mode}) · revert part ${file.part} · ${file.meals.length} meals · ${APPLY ? "APPLY" : "dry run — nothing is written"}`);

class Moved extends Error {}
const prisma = new PrismaClient();
let done = 0, moved = 0, failed = 0;
for (const m of file.meals) {
  if (only && !only.has(m.mealId)) continue;
  const pre = reviveGraph(m.pre);
  if (graphHash(pre) !== m.preHash) throw new Error(`${m.mealId}: the saved pre-image does not hash to its preHash — the file is damaged`);
  try {
    const r = await prisma.$transaction(async (tx) => {
      const now = graphHash(await readGraph(tx, m.mealId));
      if (now === m.preHash) return { note: "already at the pre-image" };
      if (now !== m.postHash) throw new Moved(`changed since the apply (hash ${now.slice(0, 12)} ≠ post ${m.postHash.slice(0, 12)})`);
      if (!APPLY) return { note: "would restore" };
      const n = await restoreGraph(tx, pre, Prisma.DbNull);
      const after = graphHash(await readGraph(tx, m.mealId));
      if (after !== m.preHash) throw new Error(`restored graph hashes ${after.slice(0, 12)}, not the pre-image ${m.preHash.slice(0, 12)} — rolled back`);
      return { note: `restored (${n.updated} rows updated, ${n.created} re-created, ${n.deleted} deleted) · hash ${after.slice(0, 12)} = pre-image` };
    }, { timeout: 120_000, maxWait: 30_000 });
    done++;
    console.log(`  ${m.mealId} "${m.title}" — ${r.note}`);
  } catch (e) {
    if (e instanceof Moved) { moved++; console.log(`  ${m.mealId} "${m.title}" — SKIPPED: ${e.message}`); }
    else { failed++; console.log(`  ${m.mealId} "${m.title}" — FAILED: ${String(e)}`); }
  }
}
console.log(`revert: ${done} ok · ${moved} changed since (skipped) · ${failed} failed`);
await prisma.$disconnect();
