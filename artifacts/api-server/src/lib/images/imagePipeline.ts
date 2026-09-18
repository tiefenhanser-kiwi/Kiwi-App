// Row 5 · Block 1 (D-WS9-246) — the sourcing chain. Since Block 1c it is ONE
// step: generate the house-prompt image, store it, or fall to the gradient.
//
//   1. ai_generated — the fixed house prompt (imageGenerator.ts), re-hosted
//      into the bucket (D-WS9-149: no third-party URL ever lands in imageUrl)
//   2. none — the TreatedImage gradient. A legitimate terminal state.
//
// The publisher-image and judged-stock steps that used to precede generation
// were built, measured and dropped (D-WS9-246: "AI for every image, no
// exceptions") and were DELETED here, not left inert. Do not re-add them.
//
// Callers: the on-save queue's drain (imageQueue.ts) runs this per claimed
// row; Block 1b's one-time catalog script (scripts/ws9-row5/generate.ts)
// composes the same two pieces itself. Nothing here touches the network on
// its own: the generator's fetch and the store's writer arrive through `deps`.

import { generateMealImage, type ImageGeneratorDeps, type ImageGenerationResult } from "./imageGenerator";
import { ImageStore, mealImageKey } from "./imageStore";
import type { ImageFetch, MealImageSubject, ResolvedMealImage } from "./types";

export interface PipelineDeps {
  fetch: ImageFetch;
  generator: Omit<ImageGeneratorDeps, "fetch">;
  store: ImageStore;
}

export interface ResolveTrace {
  generation?: ImageGenerationResult;
  // Set when the generation succeeded but the store threw (bucket outage,
  // undecodable bytes). The image is then `none` and the caller decides
  // whether that is a strike.
  storeError?: string;
  costEstimateUsd: number;
}

export interface ResolveResult {
  image: ResolvedMealImage;
  trace: ResolveTrace;
}

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

// Bounded GET of image bytes through the injected fetch. Kept for
// scripts/ws9-row5/rehost_templates.ts (the six seed templates); the pipeline
// itself no longer downloads anything — the generator returns bytes.
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

export async function resolveMealImage(
  subject: MealImageSubject,
  deps: PipelineDeps,
): Promise<ResolveResult> {
  const trace: ResolveTrace = { costEstimateUsd: 0 };
  const key = mealImageKey(subject.mealId);

  // ── 1. AI-created ─────────────────────────────────────────────────
  const generation = await generateMealImage(subject, { ...deps.generator, fetch: deps.fetch });
  trace.generation = generation;
  trace.costEstimateUsd += generation.costEstimateUsd;
  if (generation.ok) {
    try {
      const stored = await deps.store.put(key, generation.bytes);
      return { image: { source: "ai_generated", url: stored.url }, trace };
    } catch (err) {
      trace.storeError = err instanceof Error ? err.message : String(err);
    }
  }

  // ── 2. gradient ───────────────────────────────────────────────────
  return { image: { source: "none", url: null }, trace };
}
