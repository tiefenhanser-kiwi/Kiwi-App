// WS7-8b USDA Block 1 — FoodData Central (FDC) HTTP client.
//
// Thin, fail-soft wrapper over the USDA FDC v1 API. Used ONLY by the
// post-create ingredient enrichment path (ingredientEnrichment.ts), which is
// fire-and-forget: a USDA outage, rate-limit, or missing key must degrade to
// today's behavior and can NEVER throw into or slow a save. Every function
// here returns a typed result (never rejects on a transport/HTTP problem).
//
// Locked design (Hans, July 5):
//   - USDA is a REFERENCE layer only. This client fetches per-100g macros;
//     no unit conversion, no deterministic macro computation happens here.
//   - dataType defaults to Foundation + SR Legacy (generic analytical foods;
//     unfiltered search is dominated by Branded products).
//   - No retries — this is a fire-and-forget context. One 10s-timeout attempt.
//
// Verified API facts (do not re-verify online):
//   base https://api.nal.usda.gov/fdc/v1 ; auth via api_key query param;
//   GET/POST /foods/search ; GET /food/{fdcId} ; POST /foods (≤20 ids);
//   1000 req/hr → 429 + 1-hr block, X-RateLimit-* headers present;
//   Foundation/SR Legacy nutrient amounts are per-100g; energy appears as
//   BOTH kcal and kJ rows — filter by unit.

import { logger } from "../logger";

const FDC_BASE_URL = "https://api.nal.usda.gov/fdc/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DATA_TYPES = ["Foundation", "SR Legacy"] as const;
const DEFAULT_SEARCH_PAGE_SIZE = 25;
const BATCH_MAX_IDS = 20;

// ── wire types (narrow — only what enrichment needs) ────────────────────
// The FDC record shape differs between the full (GET /food, POST /foods
// default) and abridged formats. extractPer100gMacros handles both.

export interface FdcNutrientFull {
  nutrient?: { id?: number; number?: string; name?: string; unitName?: string };
  amount?: number;
}
export interface FdcNutrientAbridged {
  nutrientId?: number;
  nutrientNumber?: string;
  nutrientName?: string;
  unitName?: string;
  value?: number;
}
export type FdcNutrient = FdcNutrientFull & FdcNutrientAbridged;

export interface FdcFood {
  fdcId: number;
  description: string;
  dataType?: string;
  foodCategory?: string | { description?: string } | null;
  foodNutrients?: FdcNutrient[];
}

export interface Per100gMacros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

// Fail-soft result envelope. `ok:false` covers every non-success condition
// (disabled, HTTP error, 429, timeout, network). Callers branch on `ok` and
// never see a thrown error.
export type FdcFailureReason =
  | "disabled" // no API key configured
  | "rate_limited" // HTTP 429
  | "http_error" // other non-2xx
  | "timeout" // AbortController fired
  | "network" // fetch threw (DNS, connection reset, …)
  | "malformed"; // response body was not the expected JSON shape

export type FdcResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FdcFailureReason; status?: number };

export interface SearchFoodsOptions {
  dataType?: readonly string[];
  pageSize?: number;
}

/**
 * True when a USDA API key is configured. When false, every client function
 * short-circuits to `{ ok:false, reason:'disabled' }` and enrichment no-ops.
 */
export function isUsdaEnabled(): boolean {
  const key = process.env.USDA_INGREDIENTS_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

function apiKey(): string | null {
  const key = process.env.USDA_INGREDIENTS_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
}

// Log a rate-limit / http failure at warn with the X-RateLimit-* headers so
// the quarterly-refresh operator can see remaining budget.
function logHttpFailure(endpoint: string, res: Response): void {
  logger.warn(
    {
      event: "usda_http_failure",
      endpoint,
      status: res.status,
      rateLimitLimit: res.headers.get("x-ratelimit-limit"),
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
    },
    "USDA FDC request failed",
  );
}

// One fetch attempt with a 10s abort timeout. Never throws — maps every
// failure to an FdcResult. `T` is the parsed JSON body type on success.
async function fetchJson<T>(
  endpoint: string,
  init: RequestInit & { url: string },
): Promise<FdcResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(init.url, { ...init, signal: controller.signal });
    if (res.status === 429) {
      logHttpFailure(endpoint, res);
      return { ok: false, reason: "rate_limited", status: 429 };
    }
    if (!res.ok) {
      logHttpFailure(endpoint, res);
      return { ok: false, reason: "http_error", status: res.status };
    }
    try {
      const data = (await res.json()) as T;
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  } catch (err) {
    // AbortError → timeout; anything else → network.
    const isAbort =
      err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      logger.warn(
        { event: "usda_network_error", endpoint, err },
        "USDA FDC request errored",
      );
    }
    return { ok: false, reason: isAbort ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sanitize an ingredient name into a USDA-searchable query string. BUG-028:
 * USDA's /foods/search query parser returns HTTP 400 on some punctuation even
 * when correctly percent-encoded — notably a slash between digits
 * ("80/20 ground beef" → 400, "80 20 ground beef" → 200). This is a USDA
 * parser quirk, not a Kiwi encoding bug, so we degrade the OUTBOUND query to
 * plain searchable tokens. The Kiwi ingredient name in the DB is NOT changed.
 *
 * Transform: replace every character that is not a Unicode letter, Unicode
 * number, whitespace, apostrophe, or hyphen with a space (this covers
 * / \ % # & and other stray punctuation), then collapse whitespace runs and
 * trim. Letters (incl. accented, e.g. jalapeño), digits, intra-word hyphens,
 * and apostrophes are preserved so distinct names stay distinct.
 *
 * Over-strip guard: if sanitization yields an empty string (a name that was
 * ALL punctuation), fall back to the original query rather than sending an
 * empty search — the residual 400 is then handled per-row by the backfill.
 */
export function sanitizeUsdaQuery(query: string): string {
  const cleaned = query
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : query;
}

/**
 * Search FDC foods. Defaults the dataType filter to Foundation + SR Legacy so
 * generic ingredient lookups aren't swamped by Branded products. Returns the
 * `foods` array (possibly empty) on success. The query is sanitized
 * (see sanitizeUsdaQuery) before the request.
 */
export async function searchFoods(
  query: string,
  opts: SearchFoodsOptions = {},
): Promise<FdcResult<FdcFood[]>> {
  const key = apiKey();
  if (!key) return { ok: false, reason: "disabled" };

  const dataType = opts.dataType ?? DEFAULT_DATA_TYPES;
  const pageSize = opts.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  const params = new URLSearchParams({
    api_key: key,
    query: sanitizeUsdaQuery(query),
    pageSize: String(pageSize),
  });
  for (const dt of dataType) params.append("dataType", dt);

  const result = await fetchJson<{ foods?: FdcFood[] }>("/foods/search", {
    url: `${FDC_BASE_URL}/foods/search?${params.toString()}`,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.foods ?? [] };
}

/**
 * Fetch a single food's full record by fdcId.
 */
export async function getFood(fdcId: number): Promise<FdcResult<FdcFood>> {
  const key = apiKey();
  if (!key) return { ok: false, reason: "disabled" };

  const params = new URLSearchParams({ api_key: key });
  const result = await fetchJson<FdcFood>("/food/{fdcId}", {
    url: `${FDC_BASE_URL}/food/${fdcId}?${params.toString()}`,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  return result;
}

/**
 * Batch-fetch food records. The FDC /foods endpoint accepts at most 20 ids
 * per request; when given more, this chunks and concatenates. If any chunk
 * fails, the whole call fails soft with that chunk's reason (fire-and-forget
 * callers treat a partial batch as a miss for the unresolved ids).
 */
export async function getFoodsBatch(
  fdcIds: number[],
): Promise<FdcResult<FdcFood[]>> {
  const key = apiKey();
  if (!key) return { ok: false, reason: "disabled" };
  if (fdcIds.length === 0) return { ok: true, data: [] };

  const chunks: number[][] = [];
  for (let i = 0; i < fdcIds.length; i += BATCH_MAX_IDS) {
    chunks.push(fdcIds.slice(i, i + BATCH_MAX_IDS));
  }

  const params = new URLSearchParams({ api_key: key });
  const all: FdcFood[] = [];
  for (const chunk of chunks) {
    const result = await fetchJson<FdcFood[]>("/foods", {
      url: `${FDC_BASE_URL}/foods?${params.toString()}`,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ fdcIds: chunk }),
    });
    if (!result.ok) return result;
    all.push(...result.data);
  }
  return { ok: true, data: all };
}

// ── nutrient extraction ─────────────────────────────────────────────────
// FDC nutrient identity numbers (INFOODS/USDA standard):
//   208 Energy (kcal) — ALSO appears as 268 (kJ); filter by unitName KCAL
//   203 Protein
//   204 Total lipid (fat)
//   205 Carbohydrate, by difference
const NUTRIENT_NUMBER_ENERGY = "208";
const NUTRIENT_NUMBER_PROTEIN = "203";
const NUTRIENT_NUMBER_FAT = "204";
const NUTRIENT_NUMBER_CARBS = "205";

interface NormalizedNutrient {
  number: string | undefined;
  name: string | undefined;
  unitName: string | undefined;
  amount: number | undefined;
}

// Collapse the full and abridged nutrient shapes into one.
function normalizeNutrient(n: FdcNutrient): NormalizedNutrient {
  return {
    number: n.nutrient?.number ?? n.nutrientNumber,
    name: n.nutrient?.name ?? n.nutrientName,
    unitName: n.nutrient?.unitName ?? n.unitName,
    amount: n.amount ?? n.value,
  };
}

function findAmount(
  nutrients: NormalizedNutrient[],
  predicate: (n: NormalizedNutrient) => boolean,
): number | null {
  const hit = nutrients.find(
    (n) => predicate(n) && typeof n.amount === "number" && !Number.isNaN(n.amount),
  );
  return hit ? (hit.amount as number) : null;
}

/**
 * Extract per-100g calories/protein/carbs/fat from an FDC food record.
 * Energy is matched on the KCAL row only (the kJ row is skipped). Returns
 * null if ANY of the four macros is unresolvable — a partial record is not
 * trustworthy enough to auto-accept.
 */
export function extractPer100gMacros(food: FdcFood): Per100gMacros | null {
  const nutrients = (food.foodNutrients ?? []).map(normalizeNutrient);

  const calories = findAmount(
    nutrients,
    (n) =>
      n.number === NUTRIENT_NUMBER_ENERGY &&
      (n.unitName ?? "").toUpperCase() === "KCAL",
  );
  const protein = findAmount(nutrients, (n) => n.number === NUTRIENT_NUMBER_PROTEIN);
  const fat = findAmount(nutrients, (n) => n.number === NUTRIENT_NUMBER_FAT);
  const carbs = findAmount(nutrients, (n) => n.number === NUTRIENT_NUMBER_CARBS);

  if (
    calories === null ||
    protein === null ||
    fat === null ||
    carbs === null
  ) {
    return null;
  }
  return { calories, protein, carbs, fat };
}

/**
 * Normalize the polymorphic foodCategory field to a plain string (or null).
 * Metadata only — NEVER touches inferCategory or the category column.
 */
export function foodCategoryLabel(food: FdcFood): string | null {
  const fc = food.foodCategory;
  if (!fc) return null;
  if (typeof fc === "string") return fc;
  return fc.description ?? null;
}
