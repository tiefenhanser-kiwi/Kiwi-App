// Row 5 · Block 1 (D-WS9-246) — the sourcing chain. Four steps, in order, per
// meal; the first one that yields an accepted image wins:
//
//   1. page_extracted — a URL-imported meal's own publisher image
//   2. stock_pexels / stock_pixabay — providers queried by title, AI-judged
//   3. ai_generated — the house prompt, only when the judge accepted nothing
//   4. none — the TreatedImage gradient. A legitimate terminal state.
//
// Every accepted image is downloaded, resized and re-hosted into the bucket
// (D-WS9-149: no interim third-party URL ever lands in imageUrl). The pilot
// (scripts/ws9-row5/pilot.ts) runs steps 2 and 3 side by side WITHOUT the
// store, so `stockStep` and `generateMealImage` are also exported on their
// own. Block 1c wires resolveMealImage after the save returns; Block 1b runs
// it over the catalog.
//
// Nothing here touches the network on its own: the providers, judge,
// generator and store all arrive through `deps`.

import { hasRejectedFilenameShape, MIN_EDGE_PX, extractPageImage, type PageImageExtraction } from "./pageImageExtractor";
import { generateMealImage, IMAGE_GEN_MODEL, type ImageGeneratorDeps, type ImageGenerationResult } from "./imageGenerator";
import { ImageStore, mealImageKey, measureImage } from "./imageStore";
import { judgeImageRelevance, type JudgeDeps, type JudgeOutcome } from "./relevanceJudge";
import { buildStockQuery, StockProviderError } from "./stockProviders";
import type {
  ImageFetch,
  MealImageSubject,
  ResolvedMealImage,
  StockCandidate,
  StockImageProvider,
} from "./types";

export interface PipelineDeps {
  fetch: ImageFetch;
  providers: StockImageProvider[];
  judge: Omit<JudgeDeps, "fetch">;
  generator: Omit<ImageGeneratorDeps, "fetch">;
  store: ImageStore;
  // Fetches a recipe page's HTML for step 1. Production: recipeImport's
  // fetchRecipePage (its SSRF + size + Cloudflare guards). Optional — with no
  // fetcher and no pageHtml, step 1 is skipped.
  fetchPage?: (url: string) => Promise<{ html: string }>;
  perProviderPerPage?: number;
}

export interface ResolveOptions {
  // Step 1 inputs. `pageHtml` wins over `sourceUrl` (no second fetch).
  pageHtml?: string;
  sourceUrl?: string;
  // Test/pilot seam: skip a step entirely.
  skipStock?: boolean;
  skipGenerate?: boolean;
}

export interface StockStepOutcome {
  query: string;
  candidates: StockCandidate[];
  // Provider-level failures (a 429, a timeout) — the step continues with the
  // other provider's candidates.
  providerErrors: Array<{ provider: string; message: string }>;
  judge: JudgeOutcome | null;
  accepted: StockCandidate | null;
}

export interface ResolveTrace {
  page?: PageImageExtraction & { downloaded?: { width: number; height: number } | null; rejectedAfterDownload?: string };
  stock?: StockStepOutcome;
  generation?: ImageGenerationResult;
  costEstimateUsd: number;
}

export interface ResolveResult {
  image: ResolvedMealImage;
  trace: ResolveTrace;
}

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

export async function downloadImageBytes(fetchImpl: ImageFetch, url: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_DOWNLOAD_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Step 2 on its own: query both providers, judge, return the pick. No
// download, no store — the pilot renders this next to a generation.
export async function stockStep(
  subject: MealImageSubject,
  deps: Pick<PipelineDeps, "fetch" | "providers" | "judge" | "perProviderPerPage">,
): Promise<StockStepOutcome> {
  const query = buildStockQuery(subject.title);
  const candidates: StockCandidate[] = [];
  const providerErrors: StockStepOutcome["providerErrors"] = [];
  for (const provider of deps.providers) {
    try {
      const found = await provider.search(query, { perPage: deps.perProviderPerPage });
      candidates.push(...found.filter((c) => !hasRejectedFilenameShape(c.url)));
    } catch (err) {
      const message =
        err instanceof StockProviderError
          ? `${err.provider} HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      providerErrors.push({ provider: provider.name, message });
    }
  }
  if (candidates.length === 0) {
    return { query, candidates, providerErrors, judge: null, accepted: null };
  }
  const judge = await judgeImageRelevance(subject, candidates, { ...deps.judge, fetch: deps.fetch });
  const idx = judge.verdict?.accepted ?? null;
  const accepted = idx != null ? (judge.shown[idx] ?? null) : null;
  return { query, candidates, providerErrors, judge, accepted };
}

export function stockAttribution(c: StockCandidate): string {
  const site = c.provider === "pexels" ? "Pexels" : "Pixabay";
  return `Photo by ${c.photographer} on ${site}`;
}

export async function resolveMealImage(
  subject: MealImageSubject,
  opts: ResolveOptions,
  deps: PipelineDeps,
): Promise<ResolveResult> {
  const trace: ResolveTrace = { costEstimateUsd: 0 };
  const key = mealImageKey(subject.mealId);

  // ── 1. publisher image ────────────────────────────────────────────
  let html = opts.pageHtml ?? null;
  if (!html && opts.sourceUrl && deps.fetchPage) {
    try {
      html = (await deps.fetchPage(opts.sourceUrl)).html;
    } catch {
      html = null;
    }
  }
  if (html) {
    const extraction = extractPageImage(html);
    trace.page = { ...extraction };
    if (extraction.accepted) {
      const bytes = await downloadImageBytes(deps.fetch, extraction.accepted.url);
      const dims = bytes ? await measureImage(bytes) : null;
      trace.page.downloaded = dims;
      if (bytes && dims && Math.min(dims.width, dims.height) >= MIN_EDGE_PX) {
        const stored = await deps.store.put(key, bytes);
        return {
          image: {
            source: "page_extracted",
            url: stored.url,
            attribution: null,
            sourceUrl: opts.sourceUrl ?? extraction.accepted.url,
          },
          trace,
        };
      }
      trace.page.rejectedAfterDownload = !bytes
        ? "download_failed"
        : !dims
          ? "undecodable"
          : `too_small_${dims.width}x${dims.height}`;
    }
  }

  // ── 2. stock, judged ──────────────────────────────────────────────
  if (!opts.skipStock) {
    const stock = await stockStep(subject, deps);
    trace.stock = stock;
    trace.costEstimateUsd += stock.judge?.costEstimateUsd ?? 0;
    if (stock.accepted) {
      const bytes = await downloadImageBytes(deps.fetch, stock.accepted.url);
      if (bytes) {
        const stored = await deps.store.put(key, bytes);
        return {
          image: {
            source: stock.accepted.provider === "pexels" ? "stock_pexels" : "stock_pixabay",
            url: stored.url,
            attribution: stockAttribution(stock.accepted),
            sourceUrl: stock.accepted.sourcePageUrl,
          },
          trace,
        };
      }
    }
  }

  // ── 3. AI-created ─────────────────────────────────────────────────
  if (!opts.skipGenerate) {
    const generation = await generateMealImage(subject, { ...deps.generator, fetch: deps.fetch });
    trace.generation = generation;
    trace.costEstimateUsd += generation.costEstimateUsd;
    if (generation.ok) {
      const stored = await deps.store.put(key, generation.bytes);
      return {
        image: {
          source: "ai_generated",
          url: stored.url,
          attribution: `AI-generated (${generation.model ?? IMAGE_GEN_MODEL})`,
          sourceUrl: null,
        },
        trace,
      };
    }
  }

  // ── 4. gradient ───────────────────────────────────────────────────
  return {
    image: { source: "none", url: null, attribution: null, sourceUrl: null },
    trace,
  };
}
