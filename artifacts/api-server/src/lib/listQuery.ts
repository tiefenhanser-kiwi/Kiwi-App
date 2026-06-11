// WS7-3 A2 — shared list-endpoint helpers: comma-separated ?filter= parsing,
// limit clamping, and in-memory cursor pagination over a merged result.
//
// Used by the multi-select OR catalog reads (GET /me/meals, GET /me/dishes,
// GET /plans). Pure, generic, no DB.

// Parse a comma-separated ?filter= param into a validated, de-duplicated list
// of keys, canonically ordered by the `allowed` list. An absent/empty param
// falls back to `fallback`. Unknown values are reported for a 400.
export function parseFilterParam<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): { keys: T[] } | { unknownValues: string[] } {
  if (raw === undefined || raw === null || raw === "") {
    return { keys: [...fallback] };
  }
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { keys: [...fallback] };
  const unknownValues = parts.filter(
    (p) => !(allowed as readonly string[]).includes(p),
  );
  if (unknownValues.length > 0) return { unknownValues };
  const set = new Set(parts);
  return { keys: allowed.filter((k) => set.has(k)) };
}

// limit clamp — identical contract to GET /meals: missing/non-numeric → 20,
// otherwise clamped to [1, 100] (0 and negatives clamp up to 1).
export function clampLimit(raw: unknown): number {
  const parsed = raw === undefined ? 20 : parseInt(String(raw), 10);
  return Math.min(100, Math.max(1, Number.isNaN(parsed) ? 20 : parsed));
}

// Concatenate per-filter result blocks, de-duping by id (first occurrence
// wins). Preserves block order so each filter keeps its natural ordering.
export function mergeById<T extends { id: string }>(blocks: T[][]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const block of blocks) {
    for (const item of block) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }
  return merged;
}

// In-memory cursor pagination over a pre-merged list. The OR-union across
// heterogeneous filters can't ride a single Prisma keyset cursor, so the
// cursor is the id of the previous page's last row and the slice is computed
// in memory. The wire contract (opaque id cursor + nextCursor) matches
// GET /meals. An unknown cursor yields an empty page.
export function paginateById<T extends { id: string }>(
  rows: T[],
  cursor: string | undefined,
  limit: number,
): { page: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    const idx = rows.findIndex((r) => r.id === cursor);
    start = idx >= 0 ? idx + 1 : rows.length;
  }
  const page = rows.slice(start, start + limit);
  const nextCursor =
    start + limit < rows.length && page.length > 0
      ? page[page.length - 1].id
      : null;
  return { page, nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────
// WS7-6 B-fix Block 1 — sort-aware keyset cursor pagination.
//
// Used by GET /me/dishes (and any future sortable list endpoint). The cursor
// is opaque to clients (base64url-encoded JSON) but self-describes the sort
// it was minted under. A cursor presented under a different sort is treated
// as no-cursor (first page) rather than rejected — the wire is forgiving so
// a UI that flips sort doesn't have to remember to clear its pagination
// state. Same in-memory model as paginateById: rows arrive pre-sorted by
// the route (via Prisma `orderBy: [{ <field>, dir }, { id: "asc" }]`) and
// the cursor's id is found in the merged sorted array; the slice starts at
// the next index.

// WS7-6 B-fix Block 2: `times_cooked` ranks by MealDishLink count desc
// (mobile relabels this key "Most used" in dish contexts). The remaining
// greyed-out option in the mobile dropdown is `last_cooked` only — backed
// by `Dish.lastUsedAt`, which still has no write path (D-WS7-111).
export const DISH_SORT_KEYS = [
  "alpha",
  "date_created",
  "cook_time",
  "times_cooked",
] as const;
export type DishSortKey = (typeof DISH_SORT_KEYS)[number];

// Parse ?sort= into a known key. Invalid / missing / unknown silently
// default to "alpha" — see route prompt: don't 400 on unknown sort.
export function parseDishSortParam(raw: unknown): DishSortKey {
  if (typeof raw !== "string") return "alpha";
  return (DISH_SORT_KEYS as readonly string[]).includes(raw)
    ? (raw as DishSortKey)
    : "alpha";
}

// WS7-6 G2 scope (iii) — meal sort keys. A strict SUBSET of the dish keys
// (no `times_cooked` — a meal has no use-count sort), so the keyset cursor
// infra below (KeysetCursor / encode / decode / paginateByKeyset, all typed to
// DishSortKey) is reused as-is: every MealSortKey is assignable to DishSortKey.
// `GET /me/meals` validates its ?sort= against this constant.
export const MEAL_SORT_KEYS = ["alpha", "date_created", "cook_time"] as const;
export type MealSortKey = (typeof MEAL_SORT_KEYS)[number];

// Parse ?sort= into a known meal key. Invalid / missing / unknown silently
// default to "alpha" — same forgiving contract as parseDishSortParam.
export function parseMealSortParam(raw: unknown): MealSortKey {
  if (typeof raw !== "string") return "alpha";
  return (MEAL_SORT_KEYS as readonly string[]).includes(raw)
    ? (raw as MealSortKey)
    : "alpha";
}

export interface KeysetCursor {
  k: DishSortKey;
  v: string | number;
  i: string;
}

export function encodeKeysetCursor(c: KeysetCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

// Best-effort decode. Returns null on anything malformed — unparseable JSON,
// wrong shape, unknown sort key, missing fields — so the route falls back
// to first-page behavior. A cross-sort cursor (one whose k differs from the
// active sort) decodes successfully here and is dropped by paginateByKeyset
// at slice time.
export function decodeKeysetCursor(raw: unknown): KeysetCursor | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<KeysetCursor>;
    if (
      (parsed.k === "alpha" ||
        parsed.k === "date_created" ||
        parsed.k === "cook_time" ||
        parsed.k === "times_cooked") &&
      (typeof parsed.v === "string" || typeof parsed.v === "number") &&
      typeof parsed.i === "string"
    ) {
      return parsed as KeysetCursor;
    }
    return null;
  } catch {
    return null;
  }
}

export function paginateByKeyset<T extends { id: string }>(
  rows: T[],
  cursor: KeysetCursor | null,
  limit: number,
  sortKey: DishSortKey,
  getSortValue: (row: T) => string | number,
): { page: T[]; nextCursor: string | null } {
  let start = 0;
  // Cross-sort cursor → first page. Same-sort cursor → find by id (rows are
  // already in the comparator order Prisma applied, so id-lookup matches
  // the row the cursor was minted from).
  if (cursor && cursor.k === sortKey) {
    const idx = rows.findIndex((r) => r.id === cursor.i);
    start = idx >= 0 ? idx + 1 : rows.length;
  }
  const page = rows.slice(start, start + limit);
  if (start + limit < rows.length && page.length > 0) {
    const last = page[page.length - 1];
    return {
      page,
      nextCursor: encodeKeysetCursor({
        k: sortKey,
        v: getSortValue(last),
        i: last.id,
      }),
    };
  }
  return { page, nextCursor: null };
}
