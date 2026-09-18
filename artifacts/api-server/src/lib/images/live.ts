// Row 5 · Block 1 (D-WS9-246) — THE ONE FILE that assembles the real wiring:
// globalThis.fetch, the three provider keys from process.env, the Anthropic
// path via runAICall, and a GCS bucket authenticated by Application Default
// Credentials (no key file, no credential path — @google-cloud/storage's
// `new Storage()` reads ADC from the environment: gcloud's local ADC file on
// a dev box, the runtime service account on Cloud Run).
//
// Nothing in the hermetic suite imports this file. networkGuard.test.ts pins
// (statically) that no other file under src/lib/images/ references fetch,
// process.env, or the storage SDK, and (at runtime) that the whole pipeline
// runs with a trapped globalThis.fetch. Keep it that way: any new real
// dependency goes HERE and is injected everywhere else.
//
// Env (names only in .env.example, values in the gitignored .env):
//   PEXELS_API_KEY · PIXABAY_API_KEY · OPENAI_API_KEY · KIWI_IMAGE_BUCKET

import { Storage } from "@google-cloud/storage";

import { runAICall } from "../ai/runAICall";
import type { PrismaLike } from "../ai/promptRegistry";
import { fetchRecipePage } from "../recipeImport";
import { DEFAULT_IMAGE_BUCKET, ImageStore } from "./imageStore";
import type { PipelineDeps } from "./imagePipeline";
import { PexelsProvider, PixabayProvider } from "./stockProviders";
import type { ImageFetch, ObjectWriter, StockImageProvider } from "./types";

export const ENV_PEXELS_API_KEY = "PEXELS_API_KEY";
export const ENV_PIXABAY_API_KEY = "PIXABAY_API_KEY";
export const ENV_OPENAI_API_KEY = "OPENAI_API_KEY";
export const ENV_KIWI_IMAGE_BUCKET = "KIWI_IMAGE_BUCKET";

export const liveFetch: ImageFetch = (input, init) =>
  globalThis.fetch(input, init) as unknown as ReturnType<ImageFetch>;

export class GcsObjectWriter implements ObjectWriter {
  private readonly storage: Storage;
  constructor(private readonly bucket: string, storage?: Storage) {
    this.storage = storage ?? new Storage();
  }
  async save(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.storage.bucket(this.bucket).file(key).save(bytes, {
      contentType,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
  }
  // Block 1b — revert.ts --delete-objects. Missing object = already gone (idempotent).
  async delete(key: string): Promise<void> {
    await this.storage.bucket(this.bucket).file(key).delete({ ignoreNotFound: true });
  }
}

export interface LiveImageDepsOptions {
  prisma?: PrismaLike;
  userId?: string;
  env?: NodeJS.ProcessEnv;
  // Pilot seam: an ObjectWriter that does NOT reach the bucket (nothing is
  // uploaded in Phase 4). Production omits it → GCS.
  writer?: ObjectWriter;
}

export function liveImageBucket(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_KIWI_IMAGE_BUCKET]?.trim() || DEFAULT_IMAGE_BUCKET;
}

// Which providers have a key. A missing key drops that provider (logged by
// the caller) rather than throwing — a half-configured box still resolves
// images through the other steps.
export function liveStockProviders(env: NodeJS.ProcessEnv = process.env): StockImageProvider[] {
  const providers: StockImageProvider[] = [];
  const pexels = env[ENV_PEXELS_API_KEY]?.trim();
  const pixabay = env[ENV_PIXABAY_API_KEY]?.trim();
  if (pexels) providers.push(new PexelsProvider({ fetch: liveFetch, apiKey: pexels }));
  if (pixabay) providers.push(new PixabayProvider({ fetch: liveFetch, apiKey: pixabay }));
  return providers;
}

export function createLiveImageDeps(opts: LiveImageDepsOptions = {}): PipelineDeps {
  const env = opts.env ?? process.env;
  const bucket = liveImageBucket(env);
  return {
    fetch: liveFetch,
    providers: liveStockProviders(env),
    judge: { ai: runAICall, prisma: opts.prisma, userId: opts.userId },
    generator: {
      apiKey: env[ENV_OPENAI_API_KEY]?.trim() ?? "",
      prisma: opts.prisma,
      userId: opts.userId,
    },
    store: new ImageStore({ writer: opts.writer ?? new GcsObjectWriter(bucket), bucket }),
    fetchPage: fetchRecipePage,
  };
}
