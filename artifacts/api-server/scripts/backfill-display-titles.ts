// WS9 3f-4d Part 1 · Phase 4 (D-WS9-121) — one-time backfill.
//
// Populates two nullable/append-only fields on EXISTING records, via Haiku,
// through the Anthropic Message Batches API (50% cheaper than live calls):
//
//   1. Meal / Dish / MealPlanTemplate `displayTitle` — a short (≤42, hard-max
//      50) display name for records whose canonical `title` runs long. Rendered
//      by the app's DisplayTitle primitive as `displayTitle ?? title`.
//   2. Meal `tags` — 3-5 derived tags for meals that have none, scoped to the
//      provenances that ship untagged (wizard, live_writeback). batch_generated
//      meals are ALREADY 100% tagged (Phase 0) and are SKIPPED.
//
// SAFETY (read this before running):
//   - DRY-RUN IS THE DEFAULT. Nothing is written without the explicit --apply
//     flag. Dry-run reads the DB, prints bucket counts, and (unless --no-sample)
//     generates ~20 sample displayTitle proposals via single Haiku calls so the
//     output can be eyeballed before a real run.
//   - THIS SCRIPT NEVER WRITES `title`. Overwriting `title` would silently
//     corrupt client dedupe (dedupeByTitle.ts), the server dedupKey
//     (storeFill.ts), the wizard idempotency hash (wizardContentHash.ts), and
//     SwapMealSheet self-exclusion. assertNoTitleWrite() enforces this on every
//     update payload.
//   - IDEMPOTENT / RESUMABLE: work is selected by `displayTitle IS NULL`
//     (title buckets) and `tags = []` (tag bucket), so a re-run only processes
//     what is still outstanding. An interrupted --apply run is safe to re-run;
//     already-written records are skipped. (No state file — re-query is the
//     resume mechanism, so scripts/ stays a single file.)
//   - Dish.tags is OUT OF SCOPE (Phase 0: written, never read). Only Meal.tags.
//
// Usage (from repo root):
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-display-titles.ts            # dry-run + 20 samples
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-display-titles.ts --no-sample # dry-run, counts only
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-display-titles.ts --apply     # WRITE (batch API)
//
// Flags: --apply (write), --no-sample (skip Haiku sampling in dry-run),
//        --sample-size=N (default 20), --batch-size=N (default 500),
//        --only=titles|tags (restrict scope).

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const NO_SAMPLE = process.argv.includes("--no-sample");
const ONLY = argValue("--only"); // "titles" | "tags" | undefined
const SAMPLE_SIZE = Number(argValue("--sample-size") ?? "20");
const BATCH_SIZE = Number(argValue("--batch-size") ?? "500");

const TITLE_TARGET = 42; // aim
const TITLE_HARD_MAX = 50; // never exceed
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(flag + "="));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

// ── Anthropic (thin fetch client; no SDK dependency) ───────────────────────
function loadApiKey(): string {
  const envPath = path.join(__dirname, "..", ".env");
  const raw = fs.readFileSync(envPath, "utf8");
  const line = raw
    .split(/\r?\n/)
    .find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found in api-server/.env");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}
const API_KEY = loadApiKey();
const ANTHROPIC_HEADERS = {
  "content-type": "application/json",
  "x-api-key": API_KEY,
  "anthropic-version": "2023-06-01",
};

const TITLE_SYSTEM =
  `You shorten recipe and meal-plan titles for a cooking app's UI. Given ONE long title, return a shorter display name of ${TITLE_TARGET} characters or fewer (absolute maximum ${TITLE_HARD_MAX}) that keeps the core dish/plan identity and drops the descriptive tail — extra sides, technique adjectives, garnishes, publisher noise ("World's Best 5-Star…"). Keep the main protein or the plan's through-line. Title Case. Return ONLY the short title on one line — no quotes, no preamble, no explanation.`;

const TAGS_SYSTEM =
  `You assign tags to a home-cooked meal for filtering and search. Given the meal's title (and cuisine/difficulty when provided), return 3 to 5 short lowercase tags naming cuisine, a key ingredient, a technique, or an occasion (e.g. "italian","weeknight","lemon","pan-seared"). Skip generic filler like "dinner","meal","homemade","delicious". Return ONLY a JSON array of strings.`;

async function haikuText(system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 64,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`messages HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content: { text?: string }[] };
  return (json.content?.[0]?.text ?? "").trim();
}

// Enforce the hard cap defensively even if the model overshoots.
function clampTitle(s: string): string {
  const clean = s.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (clean.length <= TITLE_HARD_MAX) return clean;
  const cut = clean.slice(0, TITLE_HARD_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

function parseTags(s: string): string[] {
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end < 0) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((t) => String(t).toLowerCase().trim())
      .filter((t) => t.length > 0 && t.length <= 40)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ── Never-write-title guard ────────────────────────────────────────────────
function assertNoTitleWrite(data: Record<string, unknown>): void {
  if ("title" in data) {
    throw new Error(
      "SAFETY VIOLATION: backfill attempted to write `title`. This corrupts " +
        "dedupe / idempotency / self-exclusion. Aborting.",
    );
  }
}

// ── Work gathering (idempotent selectors) ──────────────────────────────────
type TitleRow = { id: string; title: string };

async function gatherTitleWork() {
  // Prisma has no portable string-length predicate; fetch the null-displayTitle
  // rows and filter by length in JS. The candidate sets are small enough
  // (< 2k meals, hundreds of templates, a few thousand dishes) to page fully.
  const overCap = (r: { title: string }) => r.title.trim().length > TITLE_TARGET;

  const meals = (
    await prisma.meal.findMany({
      where: { displayTitle: null },
      select: { id: true, title: true },
    })
  ).filter(overCap);

  const dishes = (
    await prisma.dish.findMany({
      where: { displayTitle: null },
      select: { id: true, title: true },
    })
  ).filter(overCap);

  const templates = (
    await prisma.mealPlanTemplate.findMany({
      where: { displayTitle: null },
      select: { id: true, title: true },
    })
  ).filter(overCap);

  return { meals, dishes, templates };
}

async function gatherTagWork() {
  // Only the provenances that ship untagged. batch_generated is already 100%
  // tagged (Phase 0) — excluded. Dish.tags is out of scope entirely.
  const rows = await prisma.meal.findMany({
    where: {
      sourceType: { in: ["wizard", "live_writeback"] },
      tags: { equals: [] },
    },
    select: { id: true, title: true, cuisineType: true, difficulty: true },
  });
  return rows;
}

// ── Batch API (write path) ─────────────────────────────────────────────────
type BatchRequest = {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: "user"; content: string }[];
  };
};

async function submitBatch(requests: BatchRequest[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`batch create HTTP ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function pollBatch(id: string): Promise<string> {
  // Returns the results_url once the batch has ended. Polls every 20s.
  for (;;) {
    const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${id}`, {
      headers: ANTHROPIC_HEADERS,
    });
    if (!res.ok) throw new Error(`batch get HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      processing_status: string;
      results_url: string | null;
      request_counts?: Record<string, number>;
    };
    console.log(`  batch ${id}: ${json.processing_status}`, json.request_counts ?? "");
    if (json.processing_status === "ended" && json.results_url) return json.results_url;
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

async function fetchResults(url: string): Promise<Map<string, string>> {
  const res = await fetch(url, { headers: ANTHROPIC_HEADERS });
  if (!res.ok) throw new Error(`results HTTP ${res.status}`);
  const text = await res.text();
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id: string;
      result: { type: string; message?: { content: { text?: string }[] } };
    };
    if (row.result.type === "succeeded") {
      out.set(row.custom_id, (row.result.message?.content?.[0]?.text ?? "").trim());
    } else {
      console.warn(`  ! ${row.custom_id} → ${row.result.type} (skipped)`);
    }
  }
  return out;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Apply a batch of requests and their per-custom_id writer. Splits into
// BATCH_SIZE submissions; each submission is polled to completion before the
// next, so an interrupt loses at most one in-flight batch (re-run resumes).
async function runBatch(
  requests: BatchRequest[],
  apply: (customId: string, text: string) => Promise<void>,
): Promise<void> {
  for (const [i, group] of chunk(requests, BATCH_SIZE).entries()) {
    console.log(`  submitting batch ${i + 1} (${group.length} requests)…`);
    const id = await submitBatch(group);
    const url = await pollBatch(id);
    const results = await fetchResults(url);
    for (const [customId, text] of results) await apply(customId, text);
    console.log(`  batch ${i + 1} applied (${results.size} results).`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const doTitles = ONLY !== "tags";
  const doTags = ONLY !== "titles";

  const title = doTitles ? await gatherTitleWork() : { meals: [], dishes: [], templates: [] };
  const tagRows = doTags ? await gatherTagWork() : [];

  const titleTotal = title.meals.length + title.dishes.length + title.templates.length;
  console.log("── Backfill scope (idempotent selectors) ─────────────────────");
  console.log(`displayTitle — meals >  ${TITLE_TARGET} chars, no displayTitle: ${title.meals.length}`);
  console.log(`displayTitle — dishes:                              ${title.dishes.length}`);
  console.log(`displayTitle — plan templates:                      ${title.templates.length}`);
  console.log(`displayTitle — TOTAL:                               ${titleTotal}`);
  console.log(`tags — wizard + live_writeback meals, no tags:      ${tagRows.length}`);
  console.log(`mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);

  // Rough cost estimate (Haiku 4.5 Batch pricing ≈ $0.40 / $2.00 per Mtok in/out).
  const totalCalls = titleTotal + tagRows.length;
  const estInTok = totalCalls * 90; // ~system+title
  const estOutTok = titleTotal * 16 + tagRows.length * 30;
  const estCost =
    (estInTok / 1e6) * 0.4 + (estOutTok / 1e6) * 2.0;
  console.log(
    `est. full-run cost: ~${totalCalls} calls, ~$${estCost.toFixed(3)} (Haiku Batch).`,
  );

  if (!APPLY) {
    if (!NO_SAMPLE && titleTotal > 0) {
      const sample = [...title.meals, ...title.dishes, ...title.templates].slice(
        0,
        SAMPLE_SIZE,
      );
      console.log(`\n── Sample proposals (${sample.length}, no writes) ───────────────`);
      for (const r of sample) {
        const proposed = clampTitle(await haikuText(TITLE_SYSTEM, r.title));
        console.log(`  [${r.title.length}→${proposed.length}] ${r.title}`);
        console.log(`      → ${proposed}`);
      }
    }
    console.log("\nDRY-RUN complete. Re-run with --apply to write.");
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  if (doTitles && titleTotal > 0) {
    const reqs: BatchRequest[] = [];
    for (const m of title.meals) reqs.push(titleReq("meal", m));
    for (const d of title.dishes) reqs.push(titleReq("dish", d));
    for (const t of title.templates) reqs.push(titleReq("template", t));
    console.log(`\nWriting displayTitle for ${reqs.length} records…`);
    await runBatch(reqs, async (customId, text) => {
      const [, kind, id] = customId.split(":");
      const displayTitle = clampTitle(text);
      if (!displayTitle) return;
      const data = { displayTitle };
      assertNoTitleWrite(data);
      if (kind === "meal") await prisma.meal.update({ where: { id }, data });
      else if (kind === "dish") await prisma.dish.update({ where: { id }, data });
      else if (kind === "template")
        await prisma.mealPlanTemplate.update({ where: { id }, data });
    });
  }

  if (doTags && tagRows.length > 0) {
    const reqs: BatchRequest[] = tagRows.map((m) => ({
      custom_id: `tags:meal:${m.id}`,
      params: {
        model: HAIKU_MODEL,
        max_tokens: 64,
        system: TAGS_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Title: ${m.title}\nCuisine: ${m.cuisineType ?? "unknown"}\nDifficulty: ${m.difficulty}`,
          },
        ],
      },
    }));
    console.log(`\nWriting tags for ${reqs.length} meals…`);
    await runBatch(reqs, async (customId, text) => {
      const id = customId.split(":")[2];
      const tags = parseTags(text);
      if (tags.length === 0) return;
      const data = { tags };
      assertNoTitleWrite(data);
      await prisma.meal.update({ where: { id }, data });
    });
  }

  console.log("\nAPPLY complete.");
}

function titleReq(kind: "meal" | "dish" | "template", r: TitleRow): BatchRequest {
  return {
    custom_id: `title:${kind}:${r.id}`,
    params: {
      model: HAIKU_MODEL,
      max_tokens: 64,
      system: TITLE_SYSTEM,
      messages: [{ role: "user", content: r.title }],
    },
  };
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
