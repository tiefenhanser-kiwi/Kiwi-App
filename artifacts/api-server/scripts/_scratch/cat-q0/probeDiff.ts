// CAT-Q0 B — why do 1,265 shared meals hash differently on dev and production?
// Read-only on dev; compares the production REVIEWS' verbatim quotes (from
// out/reviews.jsonl via out/prod-catalog.json) against dev's payload text for
// the same meal, and counts tie-ordered rows on dev.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/probeDiff.ts
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog } from "./catalogDb";
import { mealPayload } from "./rubric";
import { OUT, type ReviewRecord } from "./reviewRunner";

const { host, mode } = assertScriptDatabase("cat-q0/probeDiff");
console.log(`database: ${host} (${mode})`);
const prod = JSON.parse(readFileSync(join(OUT, "prod-catalog.json"), "utf8")) as { catalog: Array<{ id: string; payloadSha: string; reviewKey: string; updatedAt: string }> };
const dev = JSON.parse(readFileSync(join(OUT, "dev-catalog.json"), "utf8")) as { catalog: Array<{ id: string; payloadSha: string; updatedAt: string }> };
const devById = new Map(dev.catalog.map((c) => [c.id, c]));
const recs = new Map<string, ReviewRecord>();
for (const l of readFileSync(join(OUT, "reviews.jsonl"), "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l) as ReviewRecord; if (r.ok) recs.set(r.key, r); }

const prisma = new PrismaClient();
// tie-ordered rows on dev: dish ingredients sharing a positionIndex within a dish
const ties = await prisma.$queryRaw<Array<{ dishes: bigint; rows: bigint }>>`
  SELECT COUNT(DISTINCT "dishId") AS dishes, COUNT(*) AS rows FROM (
    SELECT "dishId", "positionIndex", COUNT(*) c FROM dish_ingredients GROUP BY 1, 2 HAVING COUNT(*) > 1) t`;
console.log(`dev dish_ingredients rows sharing a positionIndex: ${ties[0].rows} groups across ${ties[0].dishes} dishes`);
const sameStamp = prod.catalog.filter((c) => devById.has(c.id) && devById.get(c.id)!.payloadSha !== c.payloadSha && devById.get(c.id)!.updatedAt === c.updatedAt);
console.log(`differ with the SAME updatedAt: ${sameStamp.length}`);
const sample = sameStamp.slice(0, 60).map((c) => c.id);
const meals = await loadCatalog(prisma, sample);
await prisma.$disconnect();
let quotes = 0, found = 0;
const misses: string[] = [];
for (const m of meals) {
  const p = prod.catalog.find((c) => c.id === m.id)!;
  const r = recs.get(p.reviewKey);
  if (!r) continue;
  const text = JSON.stringify(mealPayload(m));
  for (const i of r.review!.issues) {
    quotes++;
    const q = i.quote.replace(/"/g, '\\"');
    if (text.includes(q) || text.includes(i.quote)) found++;
    else if (misses.length < 12) misses.push(`${m.title} — prod quote: "${i.quote}"`);
  }
}
console.log(`prod quotes found verbatim in dev's payload: ${found}/${quotes}`);
for (const x of misses) console.log(`  miss: ${x}`);
