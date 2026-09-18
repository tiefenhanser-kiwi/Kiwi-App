// Row 5 · Block 1b (D-WS9-246, amended 2026-09-18) — the full catalog image
// run. EVERY meal image is AI-generated from the byte-frozen house prompt
// (imageGenerator.ts); the TreatedImage gradient is the terminal state when
// generation fails. No stock, no page image — both steps are dead by ruling
// (their removal rides Block 1c; nothing here calls them).
//
//   node --env-file=.env --import tsx scripts/ws9-row5/generate.ts                                  # dry: counts + projected spend, no calls
//   node --env-file=.env --import tsx scripts/ws9-row5/generate.ts --limit 1 --concurrency 1 --apply  # probe: one meal, prints the rate-limit headers
//   node --env-file=.env --import tsx scripts/ws9-row5/generate.ts --limit 24 --concurrency 6 --apply # to the gate
//   node --env-file=.env --import tsx scripts/ws9-row5/generate.ts --concurrency 6 --apply           # the rest (resumable)
//   node --env-file=.env --import tsx scripts/ws9-row5/generate.ts --forks --apply                   # fork backfill (one UPDATE … FROM)
//   node --env-file=.env --import tsx scripts/ws9-row5/generate.ts --report                          # DB + bucket reconciliation, no calls
//   … --max-usd 25   the hard cap (default 25). Cumulative across restarts (run/spend.json).
//   … --ipm 5        client-side images-per-minute pacing (default 5 = the org's measured limit).
//
// ⚠️ SHARED CATALOG DATA (D-WS9-230 carve-out) — Hans ruled the run (September 18).
// Revert: revert.ts --meals --source ai_generated (nulls every row this wrote).
//
// Non-negotiables, and where each lives:
//   1. HARD DOLLAR CAP — `--max-usd` (default 25). The spend guard's daily
//      ceiling counts `userId IS NOT NULL` rows only (BUG-262) and every row
//      here is userId NULL, so this file's own accounting is the ONLY bound.
//      Checked BEFORE EVERY dispatch: spent-so-far (spend.json, survives a
//      restart) + in-flight × unit estimate. Crossing it ABORTS the run
//      (stop dispatching, drain in-flight, exit 2) — never skip-and-continue.
//   2. RESUMABLE + IDEMPOTENT — the selector is `imageUrl IS NULL` (catalog,
//      not archived) read fresh at the start of every invocation; the row
//      write is `updateMany WHERE id AND imageUrl IS NULL` and the upload is
//      preceded by a re-read of the row, so a meal that gained an image
//      between select and write is neither re-uploaded nor overwritten. A
//      crash between upload and write leaves the row NULL → the next run
//      regenerates it and overwrites the SAME object key (no orphan).
//   3. THE GATE — `--limit N` bounds one invocation; the operator stops at 25.
//   4. CONCURRENCY + BACKOFF — `--concurrency N` workers over one queue. The
//      generator's injected fetch is wrapped per attempt to read the status
//      and the `x-ratelimit-*` / `retry-after` headers (imageGenerator.ts
//      returns neither). A 429 pauses EVERY worker until retry-after (or
//      x-ratelimit-reset-requests, or 2^n × 5 s) and requeues the meal.
//   5. PER-MEAL FAILURE ISOLATION — a failed generation/upload/write is
//      recorded in run.json and the queue moves on; the row stays NULL
//      (the ruled terminal state). Retries: ≤ 2 per meal on 5xx / network /
//      bad_response / upload; none on 4xx other than 429. 429s have their
//      own per-meal budget (RATE_RETRIES) so a rate storm cannot spend a
//      meal's failure retries. Nothing is ever written partially: the five
//      image columns land in ONE update.
//   6. BUCKET KEYS `meals/<mealId>.jpg`, native 1024² (Block 1b ruling) — ImageStore.put,
//      the same resize path as the six templates.
//   7. PROVENANCE, unconditionally: imageSource ai_generated · imageGeneratedAt
//      now() · imageStatus ready (Block 1c). No other branch.
//   8. LLMCallLog mode=image per generation — inside generateMealImage
//      (prisma passed), so the spend is reconstructible from the ledger.
//   9. prisma generate is never run here; a running dev server holding the
//      engine is reported, not killed.

import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { generateMealImage, type ImageGenerationResult } from "../../src/lib/images/imageGenerator";
import { ImageStore, mealImageKey } from "../../src/lib/images/imageStore";
import { ENV_OPENAI_API_KEY, GcsObjectWriter, liveFetch, liveImageBucket } from "../../src/lib/images/live";
import { SlidingWindowRateLimiter } from "../../src/lib/images/rateLimiter";
import type { ImageFetch, MealImageSubject } from "../../src/lib/images/types";

export const OUT = "scripts/_scratch/row5-b1/run";
const RUN_JSON = `${OUT}/run.json`;
const SPEND_JSON = `${OUT}/spend.json`;
const LOG = `${OUT}/run.log`;

export const MAX_USD_DEFAULT = 25;
// The pilot's measured unit cost (50/50 ok, $0.4347 / 50). Used for the
// projection until the run has its own mean; the projection uses the LARGER.
export const PILOT_UNIT_USD = 0.0087;
export const FAILURE_RETRIES = 2;
export const RATE_RETRIES = 6;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
const WAKE_STAGGER_MS = 750;
// A run that sees this many 429 rounds in a row is throttled harder than any
// concurrency choice can fix — abort rather than crawl.
const MAX_CONSECUTIVE_429_ROUNDS = 12;

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const REPORT = argv.includes("--report");
const FORKS = argv.includes("--forks");
const num = (flag: string, dflt: number): number => {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
  return n;
};
const LIMIT = num("--limit", Infinity);
const CONCURRENCY = num("--concurrency", 2);
// The org's images-per-minute limit for gpt-image-1-mini, READ OFF THE 429
// BODY at the gate (2026-09-18): "input-images per min: Limit 5". The images
// endpoint sends no x-ratelimit-*-images header on a 2xx, so this is paced
// client-side (SlidingWindowRateLimiter, the stock providers' limiter) and
// the 429 back-off above is the safety net, not the governor. Re-read the
// 429 body and raise --ipm if Hans's tier changes.
const IPM = num("--ipm", 5);
const MAX_USD = num("--max-usd", MAX_USD_DEFAULT);

// ── run state (run.json / spend.json) ────────────────────────────────
export interface MealRunRecord {
  mealId: string;
  title: string;
  status: "ok" | "failed" | "skipped_has_image";
  url: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  rateHits: number;
  reason: string | null;
  detail: string | null;
  at: string;
}
export interface RunFile {
  startedAt: string;
  updatedAt: string;
  invocations: Array<{ at: string; limit: number | null; concurrency: number; maxUsd: number; processed: number; abort: string | null }>;
  meals: Record<string, MealRunRecord>;
  counters: { generations: number; ok: number; failed: number; skipped: number; rate429: number; retries: number };
  rateLimitHeaders: Record<string, string> | null;
  abort: string | null;
}
interface SpendFile {
  // Cumulative across restarts — the number the cap is checked against.
  spentUsd: number;
  generations: number;
  updatedAt: string;
}

function loadJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}
function saveJson(path: string, v: unknown): void {
  writeFileSync(path, JSON.stringify(v, null, 2));
}
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    writeFileSync(LOG, `${stamped}\n`, { flag: "a" });
  } catch {
    /* the console line already went out */
  }
}

// ── the per-attempt fetch wrapper: status + rate-limit headers ────────
interface AttemptCapture {
  status: number | null;
  retryAfterMs: number | null;
  headers: Record<string, string>;
}
// "6s", "1m30s", "250ms" → ms (OpenAI's x-ratelimit-reset-* format).
export function parseResetDuration(s: string | null): number | null {
  if (!s) return null;
  let ms = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const v = Number(m[1]);
    ms += m[2] === "h" ? v * 3_600_000 : m[2] === "m" ? v * 60_000 : m[2] === "s" ? v * 1000 : v;
  }
  return matched ? ms : null;
}
function capturingFetch(capture: AttemptCapture): ImageFetch {
  return async (input, init) => {
    const res = await liveFetch(input, init);
    capture.status = res.status;
    for (const name of [
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-reset-requests",
      "x-ratelimit-limit-images",
      "x-ratelimit-remaining-images",
      "x-ratelimit-reset-images",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-reset-tokens",
      "retry-after",
      "openai-processing-ms",
      "x-request-id",
    ]) {
      const v = res.headers.get(name);
      if (v != null) capture.headers[name] = v;
    }
    const ra = res.headers.get("retry-after");
    if (ra != null && Number.isFinite(Number(ra))) capture.retryAfterMs = Number(ra) * 1000;
    else capture.retryAfterMs = parseResetDuration(res.headers.get("x-ratelimit-reset-requests"));
    return res;
  };
}

// ── the queue + workers ───────────────────────────────────────────────
type Todo = { subject: MealImageSubject; attempts: number; rateHits: number };

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient();
  try {
    if (REPORT) return await report(prisma);
    if (FORKS) return await forks(prisma);
    await catalogRun(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function catalogRun(prisma: PrismaClient): Promise<void> {
  const bucket = liveImageBucket();
  const apiKey = process.env[ENV_OPENAI_API_KEY]?.trim() ?? "";
  const spend: SpendFile = loadJson<SpendFile>(SPEND_JSON) ?? { spentUsd: 0, generations: 0, updatedAt: new Date().toISOString() };
  const run: RunFile = loadJson<RunFile>(RUN_JSON) ?? {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    invocations: [],
    meals: {},
    counters: { generations: 0, ok: 0, failed: 0, skipped: 0, rate429: 0, retries: 0 },
    rateLimitHeaders: null,
    abort: null,
  };
  const saveRun = () => {
    run.updatedAt = new Date().toISOString();
    saveJson(RUN_JSON, run);
  };
  const saveSpend = () => {
    spend.updatedAt = new Date().toISOString();
    saveJson(SPEND_JSON, spend);
  };

  // The selector — fresh every invocation. Never a cached list.
  const rows = await prisma.meal.findMany({
    where: { userId: null, isArchived: false, imageUrl: null },
    select: { id: true, title: true, dishLinks: { orderBy: { positionIndex: "asc" }, select: { dish: { select: { title: true } } } } },
    orderBy: { id: "asc" },
  });
  const withImage = await prisma.meal.count({ where: { userId: null, isArchived: false, imageUrl: { not: null } } });
  const slice = rows.slice(0, Number.isFinite(LIMIT) ? LIMIT : rows.length);
  const unitUsd = spend.generations > 0 ? Math.max(PILOT_UNIT_USD, spend.spentUsd / spend.generations) : PILOT_UNIT_USD;
  const projectedUsd = spend.spentUsd + slice.length * unitUsd;
  log(
    `catalog: ${withImage} with image · ${rows.length} without · this invocation ${slice.length} · concurrency ${CONCURRENCY} · ipm ${IPM} · cap $${MAX_USD} · spent so far $${spend.spentUsd.toFixed(4)} over ${spend.generations} generations · projected after this invocation $${projectedUsd.toFixed(2)} (unit $${unitUsd.toFixed(4)}) · bucket ${bucket}`,
  );
  if (!APPLY) {
    log("DRY RUN — no calls, no writes. Pass --apply.");
    return;
  }
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  if (projectedUsd > MAX_USD) {
    log(`ABORT before any call: projected $${projectedUsd.toFixed(2)} > cap $${MAX_USD}. Lower --limit or raise --max-usd deliberately.`);
    process.exitCode = 2;
    return;
  }
  if (slice.length === 0) {
    log("nothing to do");
    return;
  }

  const store = new ImageStore({ writer: new GcsObjectWriter(bucket), bucket });
  const invocation = { at: new Date().toISOString(), limit: Number.isFinite(LIMIT) ? LIMIT : null, concurrency: CONCURRENCY, maxUsd: MAX_USD, processed: 0, abort: null as string | null };
  run.invocations.push(invocation);
  run.abort = null;
  saveRun();

  const limiter = new SlidingWindowRateLimiter({ limit: IPM, windowMs: 60_000 });
  const queue: Todo[] = slice.map((m) => ({ subject: { mealId: m.id, title: m.title, dishTitles: m.dishLinks.map((l) => l.dish.title) }, attempts: 0, rateHits: 0 }));
  let inflight = 0;
  let pausedUntil = 0;
  let consecutive429Rounds = 0;
  let aborting: string | null = null;
  const t0 = Date.now();
  const latencies: number[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const finish = (rec: MealRunRecord) => {
    run.meals[rec.mealId] = rec;
    if (rec.status === "ok") run.counters.ok++;
    else if (rec.status === "failed") run.counters.failed++;
    else run.counters.skipped++;
    invocation.processed++;
    saveRun();
  };

  const worker = async (id: number): Promise<void> => {
    while (!aborting) {
      const now = Date.now();
      if (now < pausedUntil) {
        // Staggered wake so N workers do not fire the same instant the pause lifts.
        await sleep(pausedUntil - now + (id - 1) * WAKE_STAGGER_MS);
        continue;
      }
      const todo = queue.shift();
      if (!todo) return;
      // ── the cap, before every dispatch ──
      const unit = spend.generations > 0 ? Math.max(PILOT_UNIT_USD, spend.spentUsd / spend.generations) : PILOT_UNIT_USD;
      const projected = spend.spentUsd + (inflight + 1) * unit;
      if (projected > MAX_USD) {
        aborting = `spend cap: spent $${spend.spentUsd.toFixed(4)} + ${inflight + 1} in flight × $${unit.toFixed(4)} = $${projected.toFixed(4)} > $${MAX_USD}`;
        queue.unshift(todo);
        return;
      }
      inflight++;
      const { subject } = todo;
      const tag = `[w${id} ${invocation.processed + 1}/${slice.length}] ${subject.mealId} ${subject.title}`;
      try {
        // 1. generate — its own LLMCallLog row lands inside.
        const capture: AttemptCapture = { status: null, retryAfterMs: null, headers: {} };
        todo.attempts++;
        run.counters.generations++;
        await limiter.acquire();
        const gen: ImageGenerationResult = await generateMealImage(subject, { fetch: capturingFetch(capture), apiKey, prisma });
        spend.spentUsd += gen.costEstimateUsd;
        spend.generations++;
        saveSpend();
        if (Object.keys(capture.headers).length > 0) run.rateLimitHeaders = capture.headers;

        if (!gen.ok) {
          if (capture.status === 429) {
            run.counters.rate429++;
            todo.attempts--; // a rate hit is not a failure attempt
            todo.rateHits++;
            // A round = one pause. Several workers hitting 429 inside the same
            // pause window extend it; they do not each count as a round.
            const newRound = Date.now() >= pausedUntil;
            if (newRound) consecutive429Rounds++;
            const wait = Math.min(BACKOFF_MAX_MS, capture.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** Math.min(todo.rateHits, 5));
            pausedUntil = Math.max(pausedUntil, Date.now() + wait);
            log(`${tag} · 429 (round ${consecutive429Rounds}${newRound ? "" : ", same pause"}) · pausing all workers ${(wait / 1000).toFixed(1)}s · ${gen.detail ?? ""} · ${JSON.stringify(capture.headers)}`);
            if (consecutive429Rounds >= MAX_CONSECUTIVE_429_ROUNDS) {
              aborting = `${MAX_CONSECUTIVE_429_ROUNDS} consecutive 429 rounds at concurrency ${CONCURRENCY}`;
              queue.unshift(todo);
              continue;
            }
            if (todo.rateHits <= RATE_RETRIES) queue.push(todo);
            else finish(record(subject, "failed", todo, gen, null, `rate-limited ${todo.rateHits}× (budget ${RATE_RETRIES})`));
            continue;
          }
          consecutive429Rounds = 0;
          const retryable = gen.reason === "network_error" || gen.reason === "bad_response" || (gen.reason === "http_error" && (capture.status == null || capture.status >= 500 || capture.status === 408));
          if (retryable && todo.attempts <= FAILURE_RETRIES) {
            run.counters.retries++;
            log(`${tag} · ${gen.reason} ${capture.status ?? ""} ${gen.detail ?? ""} · retry ${todo.attempts}/${FAILURE_RETRIES}`);
            queue.push(todo);
            continue;
          }
          finish(record(subject, "failed", todo, gen, null, `${gen.reason}${capture.status ? ` http ${capture.status}` : ""}: ${gen.detail ?? ""}`));
          log(`${tag} · FAILED ${gen.reason} ${capture.status ?? ""} ${gen.detail ?? ""} · $${gen.costEstimateUsd.toFixed(4)}`);
          continue;
        }
        consecutive429Rounds = 0;
        latencies.push(gen.latencyMs);

        // 2. re-read before upload: the object key is the meal id, and an
        //    image that appeared since the select must not be overwritten.
        const fresh = await prisma.meal.findUnique({ where: { id: subject.mealId }, select: { imageUrl: true } });
        if (fresh?.imageUrl) {
          finish(record(subject, "skipped_has_image", todo, gen, null, "row gained an image after select — not uploaded, not written"));
          log(`${tag} · SKIP row already has ${fresh.imageUrl} (generation spent $${gen.costEstimateUsd.toFixed(4)})`);
          continue;
        }

        // 3. upload (resize inside) — an upload failure is a retryable failure
        //    but does NOT regenerate: the bytes are kept for the retry.
        let put: Awaited<ReturnType<ImageStore["put"]>> | null = null;
        let uploadErr: string | null = null;
        for (let u = 0; u <= FAILURE_RETRIES && !put; u++) {
          try {
            put = await store.put(mealImageKey(subject.mealId), gen.bytes);
          } catch (err) {
            uploadErr = err instanceof Error ? err.message : String(err);
            run.counters.retries++;
            log(`${tag} · upload failed (${u + 1}/${FAILURE_RETRIES + 1}): ${uploadErr}`);
            await sleep(BACKOFF_BASE_MS);
          }
        }
        if (!put) {
          finish(record(subject, "failed", todo, gen, null, `upload: ${uploadErr}`));
          continue;
        }

        // 4. the row — five columns, one statement, guarded on imageUrl NULL.
        const w = await prisma.meal.updateMany({
          where: { id: subject.mealId, imageUrl: null },
          data: { imageUrl: put.url, imageSource: "ai_generated", imageGeneratedAt: new Date(), imageStatus: "ready" },
        });
        if (w.count !== 1) {
          finish(record(subject, "skipped_has_image", todo, gen, put, `updateMany matched ${w.count} rows (image appeared between re-read and write; object at ${put.url} now carries this run's bytes)`));
          log(`${tag} · WRITE SKIPPED (matched ${w.count})`);
          continue;
        }
        finish(record(subject, "ok", todo, gen, put, null));
        log(`${tag} · ok · ${put.width}×${put.height} ${put.bytes}B · $${gen.costEstimateUsd.toFixed(4)} · ${(gen.latencyMs / 1000).toFixed(1)}s · spent $${spend.spentUsd.toFixed(4)}`);
      } catch (err) {
        // Isolation: nothing thrown by one meal reaches the queue.
        const detail = err instanceof Error ? err.message : String(err);
        finish(record(subject, "failed", todo, null, null, `unexpected: ${detail}`));
        log(`${tag} · FAILED unexpected: ${detail}`);
      } finally {
        inflight--;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  const wall = (Date.now() - t0) / 1000;
  invocation.abort = aborting;
  run.abort = aborting;
  saveRun();
  const okThis = invocation.processed;
  const meanLat = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000 : 0;
  log(
    `${aborting ? `ABORT · ${aborting}` : "DONE"} · this invocation ${okThis} processed in ${wall.toFixed(0)}s (${(wall / Math.max(1, okThis)).toFixed(1)}s/meal at concurrency ${CONCURRENCY}; mean generation latency ${meanLat.toFixed(1)}s) · run totals ok ${run.counters.ok} failed ${run.counters.failed} skipped ${run.counters.skipped} 429s ${run.counters.rate429} retries ${run.counters.retries} · spent $${spend.spentUsd.toFixed(4)} over ${spend.generations} generations (unit $${(spend.spentUsd / Math.max(1, spend.generations)).toFixed(5)}) · left in queue ${queue.length}`,
  );
  if (run.rateLimitHeaders) log(`rate-limit headers (last seen): ${JSON.stringify(run.rateLimitHeaders)}`);
  const failed = Object.values(run.meals).filter((m) => m.status === "failed");
  if (failed.length) {
    log(`failures (${failed.length}) — rows left NULL (gradient):`);
    for (const f of failed) log(`  ${f.mealId} · ${f.title} · ${f.reason}`);
  }
  if (aborting) process.exitCode = 2;
}

function record(
  subject: MealImageSubject,
  status: MealRunRecord["status"],
  todo: Todo,
  gen: ImageGenerationResult | null,
  put: { url: string; width: number; height: number; bytes: number } | null,
  reason: string | null,
): MealRunRecord {
  return {
    mealId: subject.mealId,
    title: subject.title,
    status,
    url: put?.url ?? null,
    bytes: put?.bytes ?? null,
    width: put?.width ?? null,
    height: put?.height ?? null,
    costUsd: gen?.costEstimateUsd ?? 0,
    latencyMs: gen?.latencyMs ?? 0,
    attempts: todo.attempts,
    rateHits: todo.rateHits,
    reason,
    detail: gen && !gen.ok ? (gen.detail ?? null) : null,
    at: new Date().toISOString(),
  };
}

// ── the fork backfill ─────────────────────────────────────────────────
// User-owned meals forked from a catalog row (sourceStoreMealId → a userId
// NULL meal) inherit the catalog row's imageUrl AND its provenance — the
// pair forkMealForUser / createMealWithDishes drop (Block 1 report; the
// functions themselves are Block 1c). One UPDATE … FROM; only rows still
// NULL; updatedAt bumped as Prisma's @updatedAt would.
async function forks(prisma: PrismaClient): Promise<void> {
  const before = await prisma.$queryRawUnsafe<Array<{ eligible: bigint; already: bigint; target_null: bigint }>>(`
    select
      count(*) filter (where u."imageUrl" is null and c."imageUrl" is not null) as eligible,
      count(*) filter (where u."imageUrl" is not null) as already,
      count(*) filter (where c."imageUrl" is null) as target_null
    from meals u join meals c on c.id = u."sourceStoreMealId" and c."userId" is null
    where u."userId" is not null`);
  const b = before[0];
  log(`forks: eligible ${b.eligible} · already have an image ${b.already} · catalog target still NULL ${b.target_null}`);
  if (!APPLY) {
    log("DRY RUN — pass --apply.");
    return;
  }
  const n = await prisma.$executeRawUnsafe(`
    update meals u
       set "imageUrl" = c."imageUrl",
           "imageSource" = c."imageSource",
           "imageGeneratedAt" = c."imageGeneratedAt",
           "imageStatus" = 'ready',
           "updatedAt" = now()
      from meals c
     where c.id = u."sourceStoreMealId"
       and c."userId" is null
       and c."imageUrl" is not null
       and u."userId" is not null
       and u."imageUrl" is null`);
  log(`forks: UPDATED ${n} rows`);
  const check = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; imageUrl: string; imageSource: string; imageGeneratedAt: Date; sourceStoreMealId: string }>>(
    `select u.id, u.title, u."imageUrl", u."imageSource", u."imageGeneratedAt", u."sourceStoreMealId" from meals u where u."userId" is not null and u."imageSource" = 'ai_generated' order by random() limit 1`,
  );
  if (check[0]) log(`spot-check: ${JSON.stringify(check[0])}`);
}

// ── the reconciliation report ─────────────────────────────────────────
async function report(prisma: PrismaClient): Promise<void> {
  const bucket = liveImageBucket();
  const r = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    select
      count(*) filter (where "userId" is null and "isArchived" = false) as catalog,
      count(*) filter (where "userId" is null and "isArchived" = false and "imageUrl" is not null) as catalog_with_image,
      count(*) filter (where "userId" is null and "isArchived" = false and "imageUrl" is null) as catalog_null,
      count(*) filter (where "userId" is not null and "sourceStoreMealId" is not null and "imageUrl" is not null) as forks_with_image,
      count(*) filter (where "userId" is not null and "sourceStoreMealId" is null and "imageUrl" is not null) as authored_with_image,
      count(*) filter (where "imageSource" = 'ai_generated') as source_ai,
      count(*) filter (where "imageSource" is not null and "imageSource" <> 'ai_generated') as source_other,
      count(*) filter (where "imageSource" = 'ai_generated' and "imageGeneratedAt" is null) as provenance_bad,
      count(distinct "imageUrl") filter (where "userId" is null and "imageUrl" is not null) as distinct_catalog_urls
    from meals`);
  log(`db: ${JSON.stringify(r[0], (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
  const run = loadJson<RunFile>(RUN_JSON);
  const since = run?.startedAt ?? null;
  const ledger = await prisma.$queryRawUnsafe<Array<{ n: bigint; ok: bigint; usd: number; since: Date | null }>>(
    `select count(*) as n, count(*) filter (where success) as ok, coalesce(sum("costEstimateUsd"),0)::float as usd, min("createdAt") as since
       from llm_call_logs where mode = 'image' and "promptKey" = 'images.generate' ${since ? `and "createdAt" >= '${since}'` : ""}`,
  );
  const spend = loadJson<SpendFile>(SPEND_JSON);
  log(`ledger (mode=image${since ? `, createdAt ≥ run start ${since}` : ""}): rows ${ledger[0].n} · success ${ledger[0].ok} · SUM(costEstimateUsd) $${ledger[0].usd.toFixed(4)} · script spend.json $${spend?.spentUsd.toFixed(4) ?? "n/a"} over ${spend?.generations ?? 0} generations · delta $${spend ? (ledger[0].usd - spend.spentUsd).toFixed(6) : "n/a"}`);
  // Bucket objects under meals/ vs catalog rows with an image.
  const { Storage } = await import("@google-cloud/storage");
  const [files] = await new Storage().bucket(bucket).getFiles({ prefix: "meals/" });
  const keys = new Set(files.map((f) => f.name));
  const rows = await prisma.meal.findMany({ where: { userId: null, imageUrl: { not: null } }, select: { id: true, imageUrl: true } });
  const expectedKeys = new Set(rows.map((m) => mealImageKey(m.id)));
  const orphans = [...keys].filter((k) => !expectedKeys.has(k));
  const missing = [...expectedKeys].filter((k) => !keys.has(k));
  const urlMismatch = rows.filter((m) => m.imageUrl !== `https://storage.googleapis.com/${bucket}/${mealImageKey(m.id)}`);
  log(`bucket ${bucket}: ${keys.size} objects under meals/ · catalog rows with image ${rows.length} · objects with no row ${orphans.length}${orphans.length ? ` ${orphans.slice(0, 10).join(",")}` : ""} · rows with no object ${missing.length}${missing.length ? ` ${missing.slice(0, 10).join(",")}` : ""} · rows whose url is not their own key ${urlMismatch.length}`);
  if (run) {
    const failed = Object.values(run.meals).filter((m) => m.status === "failed");
    log(`run.json: ok ${run.counters.ok} failed ${run.counters.failed} skipped ${run.counters.skipped} 429s ${run.counters.rate429} retries ${run.counters.retries} · invocations ${run.invocations.length}`);
    for (const f of failed) log(`  failed ${f.mealId} · ${f.title} · ${f.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
