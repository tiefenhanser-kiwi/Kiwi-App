// CAT-Q0 Pass 2 — the live review call, one meal per call, with:
//   • a result cache on disk (out/reviews.jsonl, keyed by a hash of the exact
//     request), so a rerun never pays for the same review twice;
//   • a spend ledger (out/spend.json) and a hard ceiling checked BEFORE every
//     call — the run stops rather than crossing it;
//   • the first call alone (it writes the cache), the rest at low concurrency.
// Nothing here touches the database.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { costOf, requestFor, RUBRIC, TOOL_NAME, type ReviewOutput } from "./rubric";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const CACHE = join(OUT, "reviews.jsonl");
const SPEND = join(OUT, "spend.json");

export interface ReviewRecord {
  key: string;
  label: string;
  mealId: string;
  title: string;
  ok: boolean;
  error?: string;
  review?: ReviewOutput;
  stopReason?: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  costUsd: number;
  latencyMs: number;
  at: string;
}

export const requestKey = (userMsg: string) => createHash("sha256").update(RUBRIC).update("\u0000").update(userMsg).digest("hex").slice(0, 24);

function loadCache(): Map<string, ReviewRecord> {
  const m = new Map<string, ReviewRecord>();
  if (!existsSync(CACHE)) return m;
  for (const line of readFileSync(CACHE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as ReviewRecord;
    if (r.ok) m.set(r.key, r);
  }
  return m;
}

export function spentSoFar(): number {
  return existsSync(SPEND) ? (JSON.parse(readFileSync(SPEND, "utf8")) as { usd: number }).usd : 0;
}
function addSpend(usd: number) {
  writeFileSync(SPEND, JSON.stringify({ usd: spentSoFar() + usd, updatedAt: new Date().toISOString() }));
}

export interface ReviewJob { label: string; mealId: string; title: string; userMsg: string }

export async function runReviews(jobs: ReviewJob[], opts: { ceilingUsd: number; concurrency?: number; client?: Anthropic }): Promise<ReviewRecord[]> {
  const client = opts.client ?? new Anthropic();
  const cache = loadCache();
  const results: ReviewRecord[] = new Array(jobs.length);
  const todo: number[] = [];
  jobs.forEach((j, i) => {
    const hit = cache.get(requestKey(j.userMsg));
    if (hit) results[i] = { ...hit, label: j.label };
    else todo.push(i);
  });
  console.log(`reviews: ${jobs.length} asked · ${jobs.length - todo.length} from the on-disk cache (no spend) · ${todo.length} to call · spent so far $${spentSoFar().toFixed(4)} of a $${opts.ceilingUsd} ceiling`);

  let stopped = false;
  const one = async (i: number) => {
    if (stopped) return;
    const j = jobs[i];
    // Worst case for one call: ~6k input at full price + 4,096 output.
    if (spentSoFar() + 0.06 > opts.ceilingUsd) {
      stopped = true;
      console.log(`  STOP — the next call could cross the $${opts.ceilingUsd} ceiling (spent $${spentSoFar().toFixed(4)})`);
      return;
    }
    const key = requestKey(j.userMsg);
    const t0 = Date.now();
    let rec: ReviewRecord;
    try {
      let msg: Anthropic.Message | null = null;
      for (let attempt = 0; attempt < 3 && !msg; attempt++) {
        try {
          msg = await client.messages.create(requestFor(j.userMsg));
        } catch (e) {
          if (attempt === 2 || !(e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError)) throw e;
          await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        }
      }
      const u = msg!.usage;
      const usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 };
      const cost = costOf(usage);
      addSpend(cost);
      const tool = msg!.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
      rec = {
        key, label: j.label, mealId: j.mealId, title: j.title, ok: !!tool, ...(tool ? { review: tool.input as ReviewOutput } : { error: `no ${TOOL_NAME} call (stop_reason ${msg!.stop_reason})` }),
        stopReason: msg!.stop_reason, usage, costUsd: cost, latencyMs: Date.now() - t0, at: new Date().toISOString(),
      };
    } catch (e) {
      rec = {
        key, label: j.label, mealId: j.mealId, title: j.title, ok: false, error: e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e),
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, latencyMs: Date.now() - t0, at: new Date().toISOString(),
      };
    }
    appendFileSync(CACHE, `${JSON.stringify(rec)}\n`);
    results[i] = rec;
    const u = rec.usage;
    console.log(`  ${rec.ok ? "ok " : "ERR"} ${j.label.padEnd(14)} ${rec.review?.verdict?.padEnd(5) ?? "-    "} in ${u.input_tokens} · cache w ${u.cache_creation_input_tokens} r ${u.cache_read_input_tokens} · out ${u.output_tokens} · $${rec.costUsd.toFixed(4)} · ${rec.latencyMs} ms — ${j.title}${rec.error ? ` — ${rec.error}` : ""}`);
  };

  // The first call alone: it writes the prompt cache every later call reads.
  if (todo.length) await one(todo[0]);
  const rest = todo.slice(1);
  const conc = opts.concurrency ?? 4;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, rest.length) }, async () => {
    while (next < rest.length && !stopped) await one(rest[next++]);
  }));
  return results;
}
