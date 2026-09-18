// Row 5 · Block 1 (D-WS9-246) — THE ONE FILE that assembles the real wiring:
// globalThis.fetch, the OpenAI key from process.env, and a GCS bucket
// authenticated by Application Default Credentials (no key file, no
// credential path — @google-cloud/storage's `new Storage()` reads ADC from
// the environment: gcloud's local ADC file on a dev box, the runtime service
// account on Cloud Run).
//
// Nothing in the hermetic suite imports this file. imageNetworkGuard.test.ts
// pins (statically) that no other file under src/lib/images/ references
// fetch, process.env, or the storage SDK, and (at runtime) that the whole
// pipeline runs with a trapped globalThis.fetch. Keep it that way: any new
// real dependency goes HERE and is injected everywhere else.
//
// Block 1c: the Pexels / Pixabay providers and the relevance judge are gone
// (D-WS9-246), and with them their keys. The drain's wiring is assembled here
// too (createLiveImageDrainDeps) — same fetch, same bucket, the real prisma.
//
// Env (names only in .env.example, values in the gitignored .env):
//   OPENAI_API_KEY · KIWI_IMAGE_BUCKET

import type { PrismaClient } from "@prisma/client";
import { Storage } from "@google-cloud/storage";

import type { PrismaLike } from "../ai/promptRegistry";
import { DEFAULT_IMAGE_BUCKET, ImageStore } from "./imageStore";
import type { PipelineDeps } from "./imagePipeline";
import { createPrismaImageQueueStore, type ImageDrainDeps } from "./imageQueue";
import type { ImageFetch, ObjectWriter } from "./types";

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
  // Seam: an ObjectWriter that does NOT reach the bucket. Production omits
  // it → GCS.
  writer?: ObjectWriter;
}

export function liveImageBucket(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_KIWI_IMAGE_BUCKET]?.trim() || DEFAULT_IMAGE_BUCKET;
}

export function createLiveImageDeps(opts: LiveImageDepsOptions = {}): PipelineDeps {
  const env = opts.env ?? process.env;
  const bucket = liveImageBucket(env);
  return {
    fetch: liveFetch,
    generator: {
      apiKey: env[ENV_OPENAI_API_KEY]?.trim() ?? "",
      prisma: opts.prisma,
      userId: opts.userId,
    },
    store: new ImageStore({ writer: opts.writer ?? new GcsObjectWriter(bucket), bucket }),
  };
}

// Block 1c (D-WS9-248) — the drain's real wiring. The generator's userId is
// left unset here: runImageDrain sets it per row from the meal's owner.
export function createLiveImageDrainDeps(prisma: PrismaClient, opts: { env?: NodeJS.ProcessEnv; writer?: ObjectWriter } = {}): ImageDrainDeps {
  const env = opts.env ?? process.env;
  const bucket = liveImageBucket(env);
  return {
    store: createPrismaImageQueueStore(prisma),
    pipeline: {
      fetch: liveFetch,
      generator: { apiKey: env[ENV_OPENAI_API_KEY]?.trim() ?? "", prisma },
      store: new ImageStore({ writer: opts.writer ?? new GcsObjectWriter(bucket), bucket }),
    },
  };
}
