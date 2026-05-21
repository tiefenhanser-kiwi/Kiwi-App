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
