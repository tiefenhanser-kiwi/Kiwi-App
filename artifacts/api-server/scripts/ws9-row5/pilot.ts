// Row 5 · Block 1 · Phase 4 (D-WS9-246) — the 50-meal pilot. A MEASUREMENT:
// nothing is written to the database and nothing is uploaded to the bucket.
//
// For each of 50 RANDOM catalog meals (fixed seed, reported), BOTH paths run
// regardless of outcome — the stock lookup with the judge's verdict AND an
// AI-generated image — and both land in the gitignored pilot folder beside
// an index.html that renders them side by side. The stock hit rate is read
// off that sheet by Hans; it is not assumed here.
//
//   node --env-file=.env --import tsx scripts/ws9-row5/pilot.ts                 # the run (resumable — a meal already in pilot.json is skipped)
//   node --env-file=.env --import tsx scripts/ws9-row5/pilot.ts --limit 3       # first N of the 50 (a smoke)
//   node --env-file=.env --import tsx scripts/ws9-row5/pilot.ts --sheet-only    # rebuild index.html from pilot.json, no calls
//   node --env-file=.env --import tsx scripts/ws9-row5/pilot.ts --seed 7        # a different sample (report the seed you used)
//
// Hard caps (abort-and-report, never a throw past the cap): 50 meals,
// ≤ 2 stock queries per meal (one per provider), ≤ 1 judge call per meal,
// ≤ 1 generation per meal. Counters are checked BEFORE every call.
//
// Spend: the judge rides runAICall (LLMCallLog + spend guard); the
// generation rides generateMealImage (LLMCallLog mode=image + spend guard).
// Both run with userId null, which BUG-262 places OUTSIDE the daily ceiling
// by ruling — the caps above are what bounds this run, and the run's actual
// dollars are summed from the calls' own cost figures and written to
// pilot.json.
//
// Block 1b (the full catalog run) starts from this file: swap the sample for
// the whole catalog, drop the forced generation, add the store + DB write.

import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { generateMealImage, IMAGE_GEN_MODEL, type ImageGenerationResult } from "../../src/lib/images/imageGenerator";
import { downloadImageBytes, stockStep, type StockStepOutcome } from "../../src/lib/images/imagePipeline";
import { createLiveImageDeps, liveFetch } from "../../src/lib/images/live";
import type { MealImageSubject, ObjectWriter, StockCandidate, StockImageProvider } from "../../src/lib/images/types";

export const OUT = "scripts/_scratch/row5-b1/pilot";
const PILOT_JSON = `${OUT}/pilot.json`;
export const SAMPLE_SIZE = 50;
export const DEFAULT_SEED = 20260918;
const PER_PROVIDER_PER_PAGE = 4;

const argv = process.argv.slice(2);
const SHEET_ONLY = argv.includes("--sheet-only");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : SAMPLE_SIZE;
const seedIdx = argv.indexOf("--seed");
const SEED = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : DEFAULT_SEED;

// Caps — the numbers in the prompt, checked before every call.
const CAP = { meals: SAMPLE_SIZE, stockQueriesPerMeal: 2, judgeCallsPerMeal: 1, generationsPerMeal: 1 } as const;

// ── deterministic sample ─────────────────────────────────────────────
// mulberry32 — a small seeded PRNG; Fisher–Yates over the id-sorted catalog.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function sampleIds(sortedIds: string[], size: number, seed: number): string[] {
  const rand = mulberry32(seed);
  const arr = [...sortedIds];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, size);
}

// ── record shape (pilot.json) ────────────────────────────────────────
export interface PilotStockCandidateRecord extends StockCandidate {
  localPreview: string | null;
}
export interface PilotMealRecord {
  mealId: string;
  title: string;
  dishTitles: string[];
  query: string;
  providerErrors: StockStepOutcome["providerErrors"];
  candidates: PilotStockCandidateRecord[];
  judge: {
    called: boolean;
    accepted: number | null;
    reason: string | null;
    failureReason: string | null;
    shownCount: number;
    costUsd: number;
  };
  acceptedProvider: "pexels" | "pixabay" | null;
  generation: {
    called: boolean;
    ok: boolean;
    reason: string | null;
    detail: string | null;
    localFile: string | null;
    usage: { inputTokens: number; outputTokens: number } | null;
    costUsd: number;
    latencyMs: number;
  };
  ranAt: string;
}
export interface PilotFile {
  seed: number;
  sampleSize: number;
  catalogSize: number;
  sampleIds: string[];
  meals: PilotMealRecord[];
  counters: { stockQueries: number; judgeCalls: number; generations: number };
  spend: { judgeUsd: number; generationUsd: number; totalUsd: number };
  abort: string | null;
  startedAt: string;
  updatedAt: string;
}

function loadPilot(): PilotFile | null {
  if (!existsSync(PILOT_JSON)) return null;
  return JSON.parse(readFileSync(PILOT_JSON, "utf8")) as PilotFile;
}
function savePilot(p: PilotFile): void {
  p.updatedAt = new Date().toISOString();
  p.spend.judgeUsd = p.meals.reduce((s, m) => s + m.judge.costUsd, 0);
  p.spend.generationUsd = p.meals.reduce((s, m) => s + m.generation.costUsd, 0);
  p.spend.totalUsd = p.spend.judgeUsd + p.spend.generationUsd;
  writeFileSync(PILOT_JSON, JSON.stringify(p, null, 2));
}

// ── a provider wrapper that counts queries per meal and enforces the cap ──
class CapExceeded extends Error {}
function countingProviders(inner: StockImageProvider[], counter: { perMeal: number; total: number }): StockImageProvider[] {
  return inner.map((p) => ({
    name: p.name,
    async search(q, o) {
      if (counter.perMeal >= CAP.stockQueriesPerMeal) throw new CapExceeded(`stock queries per meal cap (${CAP.stockQueriesPerMeal})`);
      counter.perMeal++;
      counter.total++;
      return p.search(q, o);
    },
  }));
}

// The pilot never uploads: a writer that refuses is wired in so the store
// cannot be reached by accident.
const refusingWriter: ObjectWriter = {
  async save(key) {
    throw new Error(`pilot must not upload (attempted ${key})`);
  },
};

// ── the sheet ────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSheet(p: PilotFile): string {
  const accepted = p.meals.filter((m) => m.judge.accepted != null);
  const rejected = p.meals.filter((m) => m.judge.called && m.judge.accepted == null);
  const noCandidates = p.meals.filter((m) => !m.judge.called);
  const byProvider = { pexels: accepted.filter((m) => m.acceptedProvider === "pexels").length, pixabay: accepted.filter((m) => m.acceptedProvider === "pixabay").length };
  const genOk = p.meals.filter((m) => m.generation.ok).length;
  const rows = p.meals
    .map((m, i) => {
      const cands = m.candidates
        .map((c, ci) => {
          const pick = m.judge.accepted === ci;
          const img = c.localPreview ? `<img src="${esc(c.localPreview)}" loading="lazy">` : `<div class="nopreview">preview failed</div>`;
          return `<figure class="cand ${pick ? "pick" : ""}">${img}<figcaption>#${ci} · ${c.provider} · ${esc(c.photographer)}<br><span class="desc">${esc(c.description).slice(0, 90)}</span><br><a href="${esc(c.sourcePageUrl)}" target="_blank">source</a>${pick ? " · <b>JUDGE PICK</b>" : ""}</figcaption></figure>`;
        })
        .join("");
      const verdict = !m.judge.called
        ? `<span class="tag none">no candidates</span>${m.providerErrors.length ? ` <span class="err">${esc(m.providerErrors.map((e) => `${e.provider}: ${e.message}`).join("; "))}</span>` : ""}`
        : m.judge.accepted != null
          ? `<span class="tag ok">ACCEPTED #${m.judge.accepted} (${m.acceptedProvider})</span>`
          : `<span class="tag rej">REJECTED ALL${m.judge.failureReason ? ` (judge failed: ${esc(m.judge.failureReason)})` : ""}</span>`;
      const gen = m.generation.ok && m.generation.localFile
        ? `<img src="${esc(m.generation.localFile)}" loading="lazy"><figcaption>${IMAGE_GEN_MODEL} · ${m.generation.usage?.outputTokens ?? "?"} out tok · $${m.generation.costUsd.toFixed(4)} · ${(m.generation.latencyMs / 1000).toFixed(1)}s</figcaption>`
        : `<div class="nopreview">generation ${m.generation.called ? `failed: ${esc(m.generation.reason ?? "?")} ${esc(m.generation.detail ?? "")}` : "not run"}</div>`;
      return `<section class="meal" id="${esc(m.mealId)}">
  <header><span class="n">${i + 1}</span> <h2>${esc(m.title)}</h2> <code>${esc(m.mealId)}</code></header>
  <div class="dishes">${m.dishTitles.map((d) => `<span class="dish">${esc(d)}</span>`).join(" ")}</div>
  <div class="meta">query: <code>${esc(m.query)}</code> · ${verdict}${m.judge.reason ? `<div class="reason">${esc(m.judge.reason)}</div>` : ""}</div>
  <div class="cols">
    <div class="stock"><h3>Stock candidates (${m.candidates.length})</h3><div class="cands">${cands || "<em>none</em>"}</div></div>
    <div class="gen"><h3>AI-generated</h3><figure class="genfig">${gen}</figure></div>
  </div>
</section>`;
    })
    .join("\n");
  const reasons = rejected.map((m) => `<li><b>${esc(m.title)}</b> — ${esc(m.judge.reason ?? "")}</li>`).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Row 5 pilot — ${p.meals.length} meals, seed ${p.seed}</title>
<style>
  body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:24px;background:#faf7f2;color:#222}
  h1{margin:0 0 4px} .sum{background:#fff;border:1px solid #e5dccf;border-radius:8px;padding:12px 16px;margin:12px 0 24px}
  .sum b{font-size:18px} .sum ul{margin:8px 0 0;padding-left:18px;columns:2}
  .meal{background:#fff;border:1px solid #e5dccf;border-radius:10px;padding:14px 16px;margin:0 0 18px}
  header{display:flex;gap:10px;align-items:baseline} header h2{margin:0;font-size:17px} .n{color:#999;font-weight:600} code{font-size:11px;color:#777}
  .dishes{margin:6px 0} .dish{display:inline-block;background:#f0e9de;border-radius:999px;padding:2px 9px;font-size:12px;margin-right:4px}
  .meta{margin:6px 0 10px} .reason{color:#555;font-style:italic;margin-top:3px}
  .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px} .ok{background:#dcefdc;color:#1d5c1d} .rej{background:#f6dede;color:#7a1f1f} .none{background:#eee;color:#666} .err{color:#a33;font-size:12px}
  .cols{display:grid;grid-template-columns:1fr 300px;gap:16px} h3{margin:0 0 6px;font-size:13px;color:#666;text-transform:uppercase;letter-spacing:.04em}
  .cands{display:flex;flex-wrap:wrap;gap:10px} figure{margin:0} .cand{width:220px} .cand img{width:220px;height:150px;object-fit:cover;border-radius:6px;border:3px solid transparent}
  .cand.pick img{border-color:#2e8b2e} figcaption{font-size:11px;color:#555;margin-top:3px} .desc{color:#888}
  .genfig img{width:300px;height:300px;object-fit:cover;border-radius:6px} .nopreview{background:#eee;color:#888;display:flex;align-items:center;justify-content:center;width:220px;height:150px;border-radius:6px;font-size:12px;text-align:center;padding:6px}
  .genfig .nopreview{width:300px;height:300px}
</style></head><body>
<h1>Row 5 · Block 1 pilot — stock (judged) vs AI-generated</h1>
<div class="sum">
  <div>seed <b>${p.seed}</b> · sample <b>${p.meals.length}</b> of ${p.sampleSize} (catalog ${p.catalogSize}) · started ${esc(p.startedAt)}${p.abort ? ` · <span class="err">ABORTED: ${esc(p.abort)}</span>` : ""}</div>
  <div style="margin-top:8px">judge accepted from stock: <b>${accepted.length}</b> (pexels ${byProvider.pexels} · pixabay ${byProvider.pixabay}) · rejected all: <b>${rejected.length}</b> · no candidates: <b>${noCandidates.length}</b> · generations ok: <b>${genOk}</b>/${p.meals.filter((m) => m.generation.called).length}</div>
  <div>counters — stock queries ${p.counters.stockQueries} · judge calls ${p.counters.judgeCalls} · generations ${p.counters.generations} · spend judge $${p.spend.judgeUsd.toFixed(4)} + generation $${p.spend.generationUsd.toFixed(4)} = <b>$${p.spend.totalUsd.toFixed(4)}</b></div>
  ${reasons ? `<details><summary>rejection reasons (${rejected.length})</summary><ul>${reasons}</ul></details>` : ""}
</div>
${rows}
</body></html>`;
}

// ── main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  for (const sub of ["stock", "gen"]) if (!existsSync(`${OUT}/${sub}`)) mkdirSync(`${OUT}/${sub}`, { recursive: true });

  if (SHEET_ONLY) {
    const p = loadPilot();
    if (!p) throw new Error("no pilot.json to build a sheet from");
    writeFileSync(`${OUT}/index.html`, buildSheet(p));
    console.log(`sheet rebuilt → ${OUT}/index.html (${p.meals.length} meals)`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    const catalog = await prisma.meal.findMany({
      where: { userId: null, isArchived: false },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const sortedIds = catalog.map((m) => m.id);
    const ids = sampleIds(sortedIds, SAMPLE_SIZE, SEED);

    let pilot = loadPilot();
    if (pilot && (pilot.seed !== SEED || pilot.catalogSize !== sortedIds.length)) {
      throw new Error(`pilot.json is for seed ${pilot.seed} / catalog ${pilot.catalogSize}; this run is seed ${SEED} / catalog ${sortedIds.length} — move it aside first`);
    }
    if (!pilot) {
      pilot = {
        seed: SEED,
        sampleSize: SAMPLE_SIZE,
        catalogSize: sortedIds.length,
        sampleIds: ids,
        meals: [],
        counters: { stockQueries: 0, judgeCalls: 0, generations: 0 },
        spend: { judgeUsd: 0, generationUsd: 0, totalUsd: 0 },
        abort: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      savePilot(pilot);
    }
    console.log(`seed ${SEED} · catalog ${sortedIds.length} · sample ${ids.length} · already done ${pilot.meals.length} · limit ${LIMIT}`);
    console.log(`ids: ${ids.join(",")}`);

    const live = createLiveImageDeps({ prisma, writer: refusingWriter });
    if (live.providers.length !== 2) throw new Error(`expected 2 stock providers, got ${live.providers.length} (keys missing?)`);
    if (!live.generator.apiKey) throw new Error("OPENAI_API_KEY missing");

    const todo = ids.slice(0, LIMIT).filter((id) => !pilot!.meals.some((m) => m.mealId === id));
    for (const mealId of todo) {
      if (pilot.meals.length >= CAP.meals) {
        pilot.abort = `meal cap (${CAP.meals}) reached`;
        break;
      }
      const meal = await prisma.meal.findUnique({
        where: { id: mealId },
        select: {
          id: true,
          title: true,
          dishLinks: { orderBy: { positionIndex: "asc" }, select: { dish: { select: { title: true } } } },
        },
      });
      if (!meal) {
        console.log(`  ${mealId}: not found — skipped`);
        continue;
      }
      const subject: MealImageSubject = { mealId: meal.id, title: meal.title, dishTitles: meal.dishLinks.map((l) => l.dish.title) };
      const t0 = Date.now();
      process.stdout.write(`[${pilot.meals.length + 1}/${ids.length}] ${meal.title} … `);

      // ── stock + judge (≤ 2 queries, ≤ 1 judge call) ──
      const qCounter = { perMeal: 0, total: pilot.counters.stockQueries };
      let judgeCalls = 0;
      const countingJudgeAi: typeof live.judge.ai = async (k, v, s, o) => {
        if (judgeCalls >= CAP.judgeCallsPerMeal) throw new CapExceeded(`judge calls per meal cap (${CAP.judgeCallsPerMeal})`);
        judgeCalls++;
        return live.judge.ai(k, v, s, o);
      };
      let stock: StockStepOutcome;
      try {
        stock = await stockStep(subject, {
          fetch: live.fetch,
          providers: countingProviders(live.providers, qCounter),
          judge: { ...live.judge, ai: countingJudgeAi },
          perProviderPerPage: PER_PROVIDER_PER_PAGE,
        });
      } catch (err) {
        if (err instanceof CapExceeded) {
          pilot.abort = err.message;
          savePilot(pilot);
          console.log(`\nABORT: ${err.message}`);
          break;
        }
        throw err;
      }
      pilot.counters.stockQueries = qCounter.total;
      pilot.counters.judgeCalls += judgeCalls;

      // Save each candidate's preview locally so the sheet opens offline.
      const candidates: PilotStockCandidateRecord[] = [];
      for (let ci = 0; ci < stock.candidates.length; ci++) {
        const c = stock.candidates[ci];
        const bytes = await downloadImageBytes(liveFetch, c.previewUrl);
        let localPreview: string | null = null;
        if (bytes) {
          localPreview = `stock/${meal.id}-${ci}.jpg`;
          writeFileSync(`${OUT}/${localPreview}`, bytes);
        }
        candidates.push({ ...c, localPreview });
      }
      // The judge's index is into the SHOWN list; map back to the candidate index.
      const shownIdx = stock.judge?.verdict?.accepted ?? null;
      const acceptedCandidate = shownIdx != null ? stock.judge!.shown[shownIdx] : null;
      const acceptedCandidateIdx = acceptedCandidate ? stock.candidates.findIndex((c) => c.provider === acceptedCandidate.provider && c.providerId === acceptedCandidate.providerId) : null;

      // ── generation (≤ 1) — forced regardless of the judge ──
      let generation: ImageGenerationResult | null = null;
      // Per-meal ≤ 1 is structural (one call below); the run-level cap is
      // 50 × 1. The judge and stock-query run caps are checked here too.
      const runCap = {
        stockQueries: CAP.meals * CAP.stockQueriesPerMeal,
        judgeCalls: CAP.meals * CAP.judgeCallsPerMeal,
        generations: CAP.meals * CAP.generationsPerMeal,
      };
      const over = (Object.keys(runCap) as Array<keyof typeof runCap>).find(
        (k) => pilot!.counters[k] > runCap[k] || (k === "generations" && pilot!.counters[k] >= runCap[k]),
      );
      if (over) {
        pilot.abort = `run cap exceeded: ${over} ${pilot.counters[over]} vs ${runCap[over]}`;
        savePilot(pilot);
        console.log(`\nABORT: ${pilot.abort}`);
        break;
      }
      pilot.counters.generations++;
      generation = await generateMealImage(subject, { ...live.generator, fetch: live.fetch });
      let localFile: string | null = null;
      if (generation.ok) {
        localFile = `gen/${meal.id}.jpg`;
        writeFileSync(`${OUT}/${localFile}`, generation.bytes);
      }

      const rec: PilotMealRecord = {
        mealId: meal.id,
        title: meal.title,
        dishTitles: subject.dishTitles,
        query: stock.query,
        providerErrors: stock.providerErrors,
        candidates,
        judge: {
          called: (stock.judge?.shown.length ?? 0) > 0,
          accepted: acceptedCandidateIdx != null && acceptedCandidateIdx >= 0 ? acceptedCandidateIdx : null,
          reason: stock.judge?.verdict?.reason ?? null,
          failureReason: stock.judge?.failureReason ?? null,
          shownCount: stock.judge?.shown.length ?? 0,
          costUsd: stock.judge?.costEstimateUsd ?? 0,
        },
        acceptedProvider: acceptedCandidate?.provider ?? null,
        generation: {
          called: true,
          ok: generation.ok,
          reason: generation.ok ? null : generation.reason,
          detail: generation.ok ? null : (generation.detail ?? null),
          localFile,
          usage: generation.ok ? generation.usage : null,
          costUsd: generation.costEstimateUsd,
          latencyMs: generation.latencyMs,
        },
        ranAt: new Date().toISOString(),
      };
      pilot.meals.push(rec);
      savePilot(pilot);
      writeFileSync(`${OUT}/index.html`, buildSheet(pilot));
      console.log(
        `${stock.candidates.length} cand · judge ${rec.judge.accepted != null ? `ACCEPT #${rec.judge.accepted} ${rec.acceptedProvider}` : rec.judge.called ? "reject" : "n/a"} · gen ${generation.ok ? "ok" : `FAIL ${generation.reason}`} · $${(rec.judge.costUsd + rec.generation.costUsd).toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }

    writeFileSync(`${OUT}/index.html`, buildSheet(pilot));
    const accepted = pilot.meals.filter((m) => m.judge.accepted != null).length;
    console.log(
      `\nDONE · ${pilot.meals.length} meals · accepted ${accepted} · rejected ${pilot.meals.filter((m) => m.judge.called && m.judge.accepted == null).length} · no-candidates ${pilot.meals.filter((m) => !m.judge.called).length} · spend $${pilot.spend.totalUsd.toFixed(4)} (judge $${pilot.spend.judgeUsd.toFixed(4)}, gen $${pilot.spend.generationUsd.toFixed(4)}) · counters ${JSON.stringify(pilot.counters)}${pilot.abort ? ` · ABORT ${pilot.abort}` : ""}`,
    );
    console.log(`sheet → ${OUT}/index.html`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
