// CAT-Q0 B — a 2-request Message Batch with the full run's exact request shape
// (requestFor(…, 4096, ttl1h=true)), so the Batches endpoint is proven to accept
// it before the production run. Read-only on data; ~$0.02. Writes
// out/batch-smoke.json and adds the spend to the ledger.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/batchSmoke.ts
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog } from "./catalogDb";
import { mulberry32, shuffled } from "./rng";
import { costOf, requestFor, TOOL_NAME, userMessage } from "./rubric";
import { OUT, spentSoFar } from "./reviewRunner";

const { host, mode } = assertScriptDatabase("cat-q0/batchSmoke");
console.log(`database: ${host} (${mode})`);
const prisma = new PrismaClient();
const meals = shuffled(await loadCatalog(prisma), mulberry32(42)).slice(0, 2);
await prisma.$disconnect();
const client = new Anthropic();
const batch = await client.messages.batches.create({ requests: meals.map((m, i) => ({ custom_id: `smoke-${i}`, params: requestFor(userMessage(m), 4096, true) })) });
console.log(`submitted ${batch.id}`);
let b = batch;
while (b.processing_status !== "ended") {
  await new Promise((r) => setTimeout(r, 20_000));
  b = await client.messages.batches.retrieve(batch.id);
  console.log(`${new Date().toISOString().slice(11, 19)} ${b.processing_status} ${JSON.stringify(b.request_counts)}`);
}
let spend = 0;
const out: unknown[] = [];
for await (const res of await client.messages.batches.results(batch.id)) {
  if (res.result.type !== "succeeded") { console.log(`${res.custom_id}: ${res.result.type} ${JSON.stringify(res.result)}`); out.push(res); continue; }
  const msg = res.result.message;
  const tool = msg.content.find((x): x is Anthropic.ToolUseBlock => x.type === "tool_use" && x.name === TOOL_NAME);
  const cost = costOf(msg.usage, true, true);
  spend += cost;
  console.log(`${res.custom_id}: stop ${msg.stop_reason} · tool ${tool ? "yes" : "NO"} · verdict ${(tool?.input as { verdict?: string })?.verdict} · usage ${JSON.stringify(msg.usage)} · $${cost.toFixed(4)}`);
  out.push({ custom_id: res.custom_id, usage: msg.usage, verdict: (tool?.input as { verdict?: string })?.verdict });
}
writeFileSync(join(OUT, "batch-smoke.json"), JSON.stringify({ id: batch.id, results: out }, null, 1));
const SPEND = join(OUT, "spend.json");
writeFileSync(SPEND, JSON.stringify({ usd: spentSoFar() + spend, updatedAt: new Date().toISOString() }));
console.log(`smoke spend $${spend.toFixed(4)} · ledger $${(JSON.parse(readFileSync(SPEND, "utf8")) as { usd: number }).usd.toFixed(4)}`);
