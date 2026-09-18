// Row 5 · Block 1 (D-WS9-246) — the meal-image pipeline's shared types.
//
// Every provider in this folder is behind an injectable dependency: the fetch
// implementation, the AI call, the object writer, the clock. Nothing under
// src/lib/images/ touches globalThis.fetch, process.env, or a cloud SDK except
// live.ts, which is the ONE place the real wiring is assembled. The hermetic
// suite (BUG-279's class: `pnpm test` loads .env, so every key is present)
// never reaches a network call because it never imports live.ts — and
// networkGuard.test.ts pins that with a static scan plus a trapped fetch.

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

export type StockProviderName = "pexels" | "pixabay";

export interface StockCandidate {
  provider: StockProviderName;
  // The provider's own id — rides into imageSourceUrl-adjacent diagnostics.
  providerId: string;
  // Full-size (or large) image URL — what gets downloaded and re-hosted.
  url: string;
  // A ≤ ~350 px preview the relevance judge looks at. Cheap on vision tokens.
  previewUrl: string;
  width: number;
  height: number;
  photographer: string;
  // The provider's page for this photo — the credit link Pexels asks for.
  sourcePageUrl: string;
  // Provider-declared description (Pexels `alt`, Pixabay `tags`).
  description: string;
}

export interface StockImageProvider {
  readonly name: StockProviderName;
  search(query: string, opts?: { perPage?: number }): Promise<StockCandidate[]>;
}

// What the judge sees per meal. `dishTitles` is the meal's dish list, in
// position order; the judge's prompt hands both to the model.
export interface MealImageSubject {
  mealId: string;
  title: string;
  dishTitles: string[];
}

export type MealImageSource =
  | "page_extracted"
  | "stock_pexels"
  | "stock_pixabay"
  | "ai_generated"
  | "none";

// The pipeline's verdict for one meal. `url` is the PUBLIC bucket URL once
// stored; `source === "none"` means the gradient (a legitimate terminal
// state, D-WS9-246 step 4 — nothing is written to imageUrl).
export interface ResolvedMealImage {
  source: MealImageSource;
  url: string | null;
  attribution: string | null;
  sourceUrl: string | null;
}

// Uploads bytes and returns nothing; the public URL is derived from the key by
// the store, not by the writer. Production: a GCS bucket (live.ts).
export interface ObjectWriter {
  save(key: string, bytes: Buffer, contentType: string): Promise<void>;
}
