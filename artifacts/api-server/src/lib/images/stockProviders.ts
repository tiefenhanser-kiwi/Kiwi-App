// Row 5 · Block 1 (D-WS9-246 step 2) — the two stock providers behind one
// interface. Unsplash is OUT (its hotlink + credit + download-trigger terms
// are incompatible with re-hosting into our bucket); Pexels and Pixabay both
// permit download-and-host, and both are queried by meal title.
//
//   Pexels  — https://api.pexels.com/v1/search  · header Authorization: <key>
//             200 requests/hour. Asks for one prominent Pexels link on a
//             Settings/About surface and per-photo photographer credit; the
//             pipeline stores the credit in Meal.imageAttribution.
//   Pixabay — https://pixabay.com/api/           · key in the query string
//             100 requests/minute. Terms REQUIRE download-and-host (which is
//             exactly the bucket). `category=food` + `image_type=photo` narrow
//             the search; `safesearch=true`.
//
// The rate limits are respected by SlidingWindowRateLimiter — one per
// provider instance, awaited before every request. A 429 is still surfaced
// as an error (the limiter is in-process; a second process sharing the key
// would not see this one's window).
//
// fetch is INJECTED. Nothing here reads process.env or globalThis.fetch.

import { PEXELS_RATE, PIXABAY_RATE, SlidingWindowRateLimiter } from "./rateLimiter";
import type { ImageFetch, StockCandidate, StockImageProvider } from "./types";

export class StockProviderError extends Error {
  constructor(
    public readonly provider: "pexels" | "pixabay",
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StockProviderError";
  }
}

export interface StockProviderDeps {
  fetch: ImageFetch;
  apiKey: string;
  limiter?: SlidingWindowRateLimiter;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_PER_PAGE = 4;

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ── Pexels ───────────────────────────────────────────────────────────

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url?: string;
  alt?: string;
  src: { original: string; large2x?: string; large?: string; medium?: string; small?: string };
}

export class PexelsProvider implements StockImageProvider {
  readonly name = "pexels" as const;
  private readonly limiter: SlidingWindowRateLimiter;
  constructor(private readonly deps: StockProviderDeps) {
    this.limiter = deps.limiter ?? new SlidingWindowRateLimiter(PEXELS_RATE);
  }

  async search(query: string, opts: { perPage?: number } = {}): Promise<StockCandidate[]> {
    const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
    const params = new URLSearchParams({
      query,
      per_page: String(perPage),
      orientation: "landscape",
    });
    await this.limiter.acquire();
    const t = withTimeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await this.deps.fetch(`https://api.pexels.com/v1/search?${params}`, {
        method: "GET",
        headers: { Authorization: this.deps.apiKey, Accept: "application/json" },
        signal: t.signal,
      });
    } finally {
      t.clear();
    }
    if (!res.ok) {
      throw new StockProviderError("pexels", res.status, `Pexels search HTTP ${res.status}`);
    }
    const body = (await res.json()) as { photos?: PexelsPhoto[] };
    const photos = Array.isArray(body.photos) ? body.photos : [];
    return photos
      .filter((p) => p && typeof p.src?.original === "string")
      .map((p) => ({
        provider: "pexels" as const,
        providerId: String(p.id),
        // `large2x` is ~1880 px wide; `large` ~940. Either is plenty for the
        // 800 px rendition; prefer large (smaller download, same crop).
        url: p.src.large ?? p.src.large2x ?? p.src.original,
        previewUrl: p.src.medium ?? p.src.small ?? p.src.original,
        width: p.width,
        height: p.height,
        photographer: p.photographer,
        sourcePageUrl: p.url,
        description: p.alt ?? "",
      }));
  }
}

// ── Pixabay ──────────────────────────────────────────────────────────

interface PixabayHit {
  id: number;
  pageURL: string;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  tags?: string;
}

// Pixabay's documented floor for per_page is 3.
const PIXABAY_MIN_PER_PAGE = 3;
// Pixabay rejects q longer than 100 characters.
const PIXABAY_MAX_QUERY_CHARS = 100;

export class PixabayProvider implements StockImageProvider {
  readonly name = "pixabay" as const;
  private readonly limiter: SlidingWindowRateLimiter;
  constructor(private readonly deps: StockProviderDeps) {
    this.limiter = deps.limiter ?? new SlidingWindowRateLimiter(PIXABAY_RATE);
  }

  async search(query: string, opts: { perPage?: number } = {}): Promise<StockCandidate[]> {
    const perPage = Math.max(PIXABAY_MIN_PER_PAGE, opts.perPage ?? DEFAULT_PER_PAGE);
    const params = new URLSearchParams({
      key: this.deps.apiKey,
      q: query.slice(0, PIXABAY_MAX_QUERY_CHARS),
      image_type: "photo",
      category: "food",
      orientation: "horizontal",
      safesearch: "true",
      per_page: String(perPage),
    });
    await this.limiter.acquire();
    const t = withTimeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await this.deps.fetch(`https://pixabay.com/api/?${params}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: t.signal,
      });
    } finally {
      t.clear();
    }
    if (!res.ok) {
      throw new StockProviderError("pixabay", res.status, `Pixabay search HTTP ${res.status}`);
    }
    const body = (await res.json()) as { hits?: PixabayHit[] };
    const hits = Array.isArray(body.hits) ? body.hits : [];
    return hits
      .filter((h) => h && typeof h.largeImageURL === "string")
      .map((h) => ({
        provider: "pixabay" as const,
        providerId: String(h.id),
        // largeImageURL is 1280 px on the long edge; webformatURL is 640.
        url: h.largeImageURL,
        // The documented trick: webformatURL's `_640` segment can be swapped
        // for `_340` to get a ~340 px preview without a second API call.
        previewUrl: h.webformatURL.replace(/_640(\.[a-z]+)$/i, "_340$1"),
        width: h.imageWidth,
        height: h.imageHeight,
        photographer: h.user,
        sourcePageUrl: h.pageURL,
        description: h.tags ?? "",
      }));
  }
}

// ── query shaping ────────────────────────────────────────────────────

// Catalog titles are AI-authored compounds ("Miso-Glazed Salmon with Sesame
// Bok Choy"). Stock search is tag-based; the accompaniment clause drags the
// query toward zero hits. The query is the HEAD clause — the dish name —
// with parentheticals stripped. Pure, and shown per row on the pilot sheet
// so the hit rate can be read against what was actually asked.
const ACCOMPANIMENT_SPLIT = /\s+(?:with|over|on|served|alongside|and|&|\+|—|–|-)\s+|\s*,\s*/i;

export function buildStockQuery(title: string): string {
  const noParens = title.replace(/\([^)]*\)/g, " ");
  const head = noParens.split(ACCOMPANIMENT_SPLIT)[0] ?? noParens;
  const cleaned = head.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  return (cleaned || title).toLowerCase();
}
