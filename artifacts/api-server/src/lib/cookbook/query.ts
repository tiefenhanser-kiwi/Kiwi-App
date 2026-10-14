// BOOK-1S (D-WS9-312) — the Cookbook search request: its query schema, the
// cuisine vocabulary it accepts, and the opaque cursor.
//
// Express hands a query string over as strings (or string[] for a repeated
// key), so every field is parsed from that shape here and a bad value is a 400
// at the route, never a silently-dropped filter.

import { z } from "zod";


// The canonical cuisine tokens store/cuisineNormalize.ts produces — the 84 raw
// `cuisineType` strings reduce to these. Listed here because that module keeps
// its rule table private; cookbook.test.ts pins that every token below is
// one normalizeCuisineTokens actually emits for itself, so a renamed token
// fails a test rather than quietly matching nothing.
export const CUISINE_TOKENS = [
  "african",
  "american",
  "asian",
  "bbq",
  "brazilian",
  "cajun",
  "caribbean",
  "chinese",
  "comfort-food",
  "french",
  "greek",
  "indian",
  "italian",
  "japanese",
  "korean",
  "latin-american",
  "mediterranean",
  "mexican",
  "middle-eastern",
  "soul-food",
  "spanish",
  "tex-mex",
  "thai",
  "vietnamese",
] as const;

export type CuisineToken = (typeof CUISINE_TOKENS)[number];

export const COOKBOOK_SORTS = ["popular", "quickest", "az"] as const;
export type CookbookSort = (typeof COOKBOOK_SORTS)[number];

export const COOKBOOK_DEFAULT_LIMIT = 30;
export const COOKBOOK_MAX_LIMIT = 50;
export const COOKBOOK_MIN_QUERY_LENGTH = 2;

/** One query-string value: the last of a repeated key wins for scalars. */
const single = (v: unknown): unknown => (Array.isArray(v) ? v[v.length - 1] : v);

/** `cuisine=thai&cuisine=indian` and `cuisine=thai,indian` both read as a list. */
const list = (v: unknown): unknown => {
  if (v === undefined) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) =>
    typeof x === "string" ? x.split(",") : [x],
  );
  const cleaned = parts
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : x))
    .filter((x) => x !== "");
  return cleaned.length > 0 ? cleaned : undefined;
};

export const CookbookQuerySchema = z
  .object({
    // Trimmed; empty means "no query". One character is refused rather than
    // run: it matches nearly every ingredient name and is never what was meant.
    q: z.preprocess(
      (v) => {
        const s = single(v);
        if (typeof s !== "string") return s;
        const t = s.trim();
        return t === "" ? undefined : t;
      },
      z.string().min(COOKBOOK_MIN_QUERY_LENGTH).max(100).optional(),
    ),
    cuisine: z.preprocess(list, z.array(z.enum(CUISINE_TOKENS)).max(CUISINE_TOKENS.length).optional()),
    maxMinutes: z.preprocess(
      (v) => {
        const s = single(v);
        return typeof s === "string" && /^\d+$/.test(s) ? Number(s) : s;
      },
      z.union([z.literal(30), z.literal(45), z.literal(60)]).optional(),
    ),
    tag: z.preprocess(
      (v) => {
        const s = single(v);
        return typeof s === "string" ? s.trim().toLowerCase() : s;
      },
      z.string().regex(/^[a-z0-9][a-z0-9 -]{0,39}$/).optional(),
    ),
    sort: z.preprocess(single, z.enum(COOKBOOK_SORTS).default("popular")),
    cursor: z.preprocess(single, z.string().min(1).max(500).optional()),
    limit: z.preprocess(
      (v) => {
        const s = single(v);
        return typeof s === "string" && /^\d+$/.test(s) ? Number(s) : s;
      },
      z.number().int().min(1).max(COOKBOOK_MAX_LIMIT).default(COOKBOOK_DEFAULT_LIMIT),
    ),
  })
  .strict();

export type CookbookQuery = z.infer<typeof CookbookQuerySchema>;

// ── the cursor ──────────────────────────────────────────────────────────────
//
// Keyset, not offset: the cursor carries the last row's full sort key (which
// always ends in the meal id, so keys are unique), and the next page starts at
// the first row strictly after it. A meal added or removed between two page
// reads therefore cannot shift the window and make a row repeat or vanish.
// Opaque to the client — base64url JSON — and bound to the sort it was minted
// under: a cursor replayed against another sort is a 400, not a wrong page.

export type SortKey = ReadonlyArray<string | number>;

/** The key shape each sort mints: element types in order. */
const KEY_SHAPE: Record<CookbookSort, ReadonlyArray<"string" | "number">> = {
  popular: ["number", "string", "string"],
  quickest: ["number", "number", "string"],
  az: ["string", "string"],
};

export function encodeCursor(sort: CookbookSort, key: SortKey): string {
  return Buffer.from(JSON.stringify({ s: sort, k: key }), "utf8").toString("base64url");
}

/** The decoded key, or null when the cursor is malformed or from another sort. */
export function decodeCursor(sort: CookbookSort, cursor: string): SortKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { s, k } = parsed as { s?: unknown; k?: unknown };
  if (s !== sort || !Array.isArray(k)) return null;
  const shape = KEY_SHAPE[sort];
  if (k.length !== shape.length) return null;
  for (let i = 0; i < shape.length; i++) {
    if (typeof k[i] !== shape[i]) return null;
    if (shape[i] === "number" && !Number.isFinite(k[i])) return null;
  }
  return k as SortKey;
}

