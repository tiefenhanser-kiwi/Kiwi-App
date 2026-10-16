// CAT-Q1 — READ-ONLY: the full row-graph hash (graph.ts) of each listed meal
// and one hash over all of them — taken before an apply and after its revert,
// independently of revert.ts's own in-transaction check.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/hashGraphs.ts (--ids a,b | --revert-file <path> | --seed) [--each]
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { graphHash, readGraph } from "./graph";
import { SEED_IDS } from "./issues";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : ""; };
const { host, mode } = assertScriptDatabase("cat-q1/hashGraphs");
const ids = process.argv.includes("--seed") ? [...SEED_IDS]
  : arg("--revert-file") ? (JSON.parse(readFileSync(arg("--revert-file"), "utf8")) as { meals: Array<{ mealId: string }> }).meals.map((m) => m.mealId)
  : arg("--ids").split(",").filter(Boolean);
const prisma = new PrismaClient();
const per: string[] = [];
for (const id of [...ids].sort()) {
  const h = graphHash(await readGraph(prisma, id));
  per.push(`${id}:${h}`);
  if (process.argv.includes("--each")) console.log(`  ${id} ${h.slice(0, 16)}`);
}
await prisma.$disconnect();
console.log(`${host} (${mode}) · ${ids.length} meals · graph hash ${createHash("sha256").update(per.join("\n")).digest("hex")}`);
