// CAT-Q1 — READ-ONLY check after an apply: each patched meal, read back from
// the database the way CAT-Q0 reads it, must produce EXACTLY the review payload
// plan.ts approved (patch.afterKey — the same hash the re-review was keyed on).
// The stamps written after the edits (allergens, derived times) are part of
// that payload, so a stamp that disagrees with the gate's in-memory one shows.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/check.ts --set pilot|rest [--status accepted,b-only]
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog } from "../cat-q0/catalogDb";
import { buildVocab, checkMeal, CLASS_OF } from "../cat-q0/checks";
import { mealPayload, userMessage } from "../cat-q0/rubric";
import { requestKey } from "../cat-q0/reviewRunner";
import { OUT, pilotIds, readIssues, restIds } from "./issues";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const { host, mode } = assertScriptDatabase("cat-q1/check");
const issues = readIssues();
const want = new Set(arg("--set", "pilot") === "rest" ? restIds(issues) : pilotIds(issues));
const statuses = new Set(arg("--status", "accepted").split(","));
const dir = join(OUT, mode, "patches");
const patches = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { mealId: string; title: string; status: string; afterKey: string; payloadKey: string })
  .filter((p) => want.has(p.mealId) && statuses.has(p.status));
const prisma = new PrismaClient();
const catalog = await loadCatalog(prisma);
await prisma.$disconnect();
const vocab = buildVocab(catalog);
const byId = new Map(catalog.map((m) => [m.id, m]));
let same = 0, before = 0;
console.log(`${host} (${mode}) · ${patches.length} patches (${[...statuses].join(",")})`);
for (const p of patches) {
  const m = byId.get(p.mealId);
  if (!m) { console.log(`  ${p.mealId} — not in the catalog`); continue; }
  const k = requestKey(userMessage(m));
  const n = checkMeal(m, vocab).filter((f) => typeof CLASS_OF[f.code] === "number").length;
  if (k === p.afterKey) { same++; console.log(`  = ${p.mealId} "${p.title}" — the approved payload · Pass 1 numbered findings ${n}`); }
  else if (k === p.payloadKey) { before++; console.log(`  · ${p.mealId} "${p.title}" — still the UNPATCHED payload`); }
  else {
    const pl = mealPayload(m);
    console.log(`  ≠ ${p.mealId} "${p.title}" — neither (times ${pl.derivedTotalMinutes}/${pl.derivedHandsOnMinutes} · allergens ${pl.allergens.join(",")})`);
  }
}
console.log(`check: ${same} match the approved payload · ${before} unpatched · ${patches.length - same - before} differ`);
