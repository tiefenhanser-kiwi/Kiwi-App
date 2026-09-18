// Row 5 · Block 1 (D-WS9-246) — the meal-image pipeline's shared types.
//
// Everything in this folder is behind an injectable dependency: the fetch
// implementation, the object writer, the prisma client. Nothing under
// src/lib/images/ touches globalThis.fetch, process.env, or a cloud SDK except
// live.ts, which is the ONE place the real wiring is assembled. The hermetic
// suite (BUG-279's class: `pnpm test` loads .env, so every key is present)
// never reaches a network call because it never imports live.ts — and
// imageNetworkGuard.test.ts pins that with a static scan plus a trapped fetch.
//
// Block 1c: the stock providers, the relevance judge and the publisher-image
// extractor are DELETED (D-WS9-246: AI for every image, no exceptions), and
// their types with them.

// The subset of fetch the pipeline uses. Structural so a test can hand in a
// plain function; production passes globalThis.fetch (live.ts).
export type ImageFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ImageFetchResponse>;

export interface ImageFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

// What the generator sees per meal. `dishTitles` is the meal's dish list, in
// position order; the house prompt hands both to the model.
export interface MealImageSubject {
  mealId: string;
  title: string;
  dishTitles: string[];
}

export type MealImageSource = "ai_generated" | "none";

// The pipeline's verdict for one meal. `url` is the PUBLIC bucket URL once
// stored; `source === "none"` means the gradient (a legitimate terminal
// state, D-WS9-246 — nothing is written to imageUrl).
export interface ResolvedMealImage {
  source: MealImageSource;
  url: string | null;
}

// Uploads bytes and returns nothing; the public URL is derived from the key by
// the store, not by the writer. Production: a GCS bucket (live.ts).
export interface ObjectWriter {
  save(key: string, bytes: Buffer, contentType: string): Promise<void>;
}
