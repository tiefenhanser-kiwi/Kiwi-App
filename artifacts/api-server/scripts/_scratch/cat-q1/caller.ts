// CAT-Q1 — the model calls (editor, baseline review, re-review), one runner:
//   • a result cache on disk (out/calls.jsonl), keyed by a hash of the exact
//     request — a rerun never pays for the same call twice;
//   • the lane's spend ledger (out/spend.json) and a per-run ceiling checked
//     BEFORE every live call; a batch is refused unless its worst case fits;
//   • live (concurrency 4, the first call alone so it writes the prompt cache)
//     or a Message Batch (50%, 1-hour cache), polled to the end. A batch's id
//     is saved first (out/batches.json), so an interrupted run collects it
//     instead of submitting — and paying for — the same requests again.
// Nothing here touches the database. CAT-Q0's reviews.jsonl is READ (a review
// it already made of the exact payload costs nothing) and never written.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { costOf } from "../cat-q0/rubric";
import { OUT, Q0_OUT } from "./issues";

mkdirSync(OUT, { recursive: true });
const CALLS = join(OUT, "calls.jsonl");
const SPEND = join(OUT, "spend.json");
const BATCHES = join(OUT, "batches.json");

export interface CallJob { label: string; mealId: string; tool: string; request: Anthropic.MessageCreateParamsNonStreaming }
export interface CallRecord {
  key: string; label: string; mealId: string; ok: boolean; input?: unknown; error?: string; stopReason?: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  costUsd: number; batch: boolean; at: string;
}

export const callKey = (r: Anthropic.MessageCreateParamsNonStreaming) => {
  // The cache TTL and max_tokens do not change what the model is asked.
  const { max_tokens: _m, ...rest } = r as unknown as Record<string, unknown>;
  const sys = (rest.system as Array<{ text: string }>).map((s) => s.text);
  return createHash("sha256").update(JSON.stringify({ ...rest, system: sys })).digest("hex").slice(0, 24);
};

function readCache(): Map<string, CallRecord> {
  const m = new Map<string, CallRecord>();
  if (existsSync(CALLS)) for (const l of readFileSync(CALLS, "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l) as CallRecord; if (r.ok) m.set(r.key, r); }
  return m;
}
export const spentSoFar = () => (existsSync(SPEND) ? (JSON.parse(readFileSync(SPEND, "utf8")) as { usd: number }).usd : 0);
const addSpend = (usd: number) => writeFileSync(SPEND, JSON.stringify({ usd: spentSoFar() + usd, updatedAt: new Date().toISOString() }));

/** CAT-Q0's own review of this exact user message, if it made one (free). */
let q0: Map<string, { verdict: string; issues: unknown[] }> | null = null;
export function q0Review(reviewKey: string): { verdict: string; issues: unknown[] } | null {
  if (!q0) {
    q0 = new Map();
    const f = join(Q0_OUT, "reviews.jsonl");
    if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as { key: string; ok: boolean; review?: { verdict: string; issues: unknown[] } };
      if (r.ok && r.review) q0.set(r.key, r.review);
    }
  }
  return q0.get(reviewKey) ?? null;
}

const usageOf = (u: Anthropic.Usage) => ({ input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 });
function record(key: string, j: CallJob, msg: Anthropic.Message, batch: boolean): CallRecord {
  const usage = usageOf(msg.usage);
  const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === j.tool);
  return {
    key, label: j.label, mealId: j.mealId, ok: !!tool, ...(tool ? { input: tool.input } : { error: `no ${j.tool} call (stop_reason ${msg.stop_reason})` }),
    stopReason: msg.stop_reason, usage, costUsd: costOf(usage, batch, batch), batch, at: new Date().toISOString(),
  };
}

/** Worst case for one call: the whole request uncached at full price + max_tokens out. */
function worstCost(j: CallJob, batch: boolean) {
  const chars = JSON.stringify(j.request.system).length + JSON.stringify(j.request.messages).length + JSON.stringify(j.request.tools ?? []).length;
  return costOf({ input_tokens: Math.ceil(chars / 3), output_tokens: j.request.max_tokens }, batch);
}

export async function runCalls(jobs: CallJob[], opts: { ceilingUsd: number; batch?: boolean; client?: Anthropic; log?: (s: string) => void }): Promise<Map<string, CallRecord>> {
  const log = opts.log ?? console.log;
  const client = opts.client ?? new Anthropic();
  const cache = readCache();
  const out = new Map<string, CallRecord>();
  const keyed = jobs.map((j) => ({ j, key: callKey(j.request) }));
  const todo = keyed.filter((x) => { const hit = cache.get(x.key); if (hit) out.set(x.key, hit); return !hit; });
  // one call per distinct request
  const uniq = [...new Map(todo.map((x) => [x.key, x])).values()];
  const base = spentSoFar();
  log(`calls: ${jobs.length} asked · ${jobs.length - todo.length} cached · ${uniq.length} to make (${opts.batch ? "batch" : "live"}) · lane spend so far $${base.toFixed(4)} · this run's ceiling $${opts.ceilingUsd}`);
  if (!uniq.length) return out;

  if (opts.batch) {
    const worst = uniq.reduce((a, x) => a + worstCost(x.j, true), 0);
    const saved = existsSync(BATCHES) ? (JSON.parse(readFileSync(BATCHES, "utf8")) as Array<{ id: string; keys: string[]; collected: boolean }>) : [];
    const want = new Set(uniq.map((x) => x.key));
    let entry = saved.find((b) => !b.collected && b.keys.some((k) => want.has(k)));
    if (!entry) {
      if (worst > opts.ceilingUsd) throw new Error(`refusing: the batch's worst case $${worst.toFixed(2)} exceeds the $${opts.ceilingUsd} ceiling`);
      const b = await client.messages.batches.create({ requests: uniq.map((x) => ({ custom_id: x.key, params: x.j.request })) });
      entry = { id: b.id, keys: uniq.map((x) => x.key), collected: false };
      saved.push(entry);
      writeFileSync(BATCHES, JSON.stringify(saved, null, 1));
      log(`submitted batch ${b.id} (${uniq.length} requests, worst case $${worst.toFixed(2)})`);
    } else log(`collecting the batch already submitted: ${entry.id}`);
    let b = await client.messages.batches.retrieve(entry.id);
    while (b.processing_status !== "ended") {
      log(`${new Date().toISOString().slice(11, 19)} batch ${b.id}: ${b.processing_status} · ${JSON.stringify(b.request_counts)}`);
      await new Promise((r) => setTimeout(r, 60_000));
      b = await client.messages.batches.retrieve(entry.id);
    }
    const byKey = new Map(uniq.map((x) => [x.key, x.j]));
    let spend = 0;
    for await (const res of await client.messages.batches.results(entry.id)) {
      const j = byKey.get(res.custom_id) ?? { label: "?", mealId: "?", tool: "?", request: uniq[0].j.request };
      let rec: CallRecord;
      if (res.result.type !== "succeeded") rec = { key: res.custom_id, label: j.label, mealId: j.mealId, ok: false, error: res.result.type, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, batch: true, at: new Date().toISOString() };
      else rec = record(res.custom_id, j, res.result.message, true);
      spend += rec.costUsd;
      appendFileSync(CALLS, `${JSON.stringify(rec)}\n`);
      if (rec.ok) out.set(rec.key, rec);
    }
    addSpend(spend);
    entry.collected = true;
    writeFileSync(BATCHES, JSON.stringify(saved, null, 1));
    log(`batch ${entry.id} collected · $${spend.toFixed(4)}`);
    return out;
  }

  let stopped = false;
  const one = async (x: (typeof uniq)[number]) => {
    if (stopped) return;
    if (spentSoFar() - base + worstCost(x.j, false) > opts.ceilingUsd) { stopped = true; log(`  STOP — the next call could cross the $${opts.ceilingUsd} ceiling (this run $${(spentSoFar() - base).toFixed(4)})`); return; }
    const t0 = Date.now();
    let rec: CallRecord;
    try {
      let msg: Anthropic.Message | null = null;
      for (let a = 0; a < 3 && !msg; a++) {
        try { msg = await client.messages.create(x.j.request); }
        catch (e) {
          if (a === 2 || !(e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError)) throw e;
          await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
        }
      }
      rec = record(x.key, x.j, msg!, false);
    } catch (e) {
      rec = { key: x.key, label: x.j.label, mealId: x.j.mealId, ok: false, error: e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e), usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, batch: false, at: new Date().toISOString() };
    }
    addSpend(rec.costUsd);
    appendFileSync(CALLS, `${JSON.stringify(rec)}\n`);
    if (rec.ok) out.set(rec.key, rec);
    const u = rec.usage;
    log(`  ${rec.ok ? "ok " : "ERR"} ${x.j.label.padEnd(9)} in ${u.input_tokens} · cache w ${u.cache_creation_input_tokens} r ${u.cache_read_input_tokens} · out ${u.output_tokens} · $${rec.costUsd.toFixed(4)} · ${Date.now() - t0} ms — ${x.j.mealId}${rec.error ? ` — ${rec.error}` : ""}`);
  };
  // the first call of each label alone: it writes that prefix's prompt cache
  const firsts = [...new Map(uniq.map((x) => [x.j.label, x])).values()];
  for (const f of firsts) await one(f);
  const rest = uniq.filter((x) => !firsts.includes(x));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rest.length) }, async () => { while (next < rest.length && !stopped) await one(rest[next++]); }));
  return out;
}
