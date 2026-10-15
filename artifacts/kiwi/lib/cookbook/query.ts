// BOOK-1C1 (D-WS9-312) — the Cookbook screen's filter state and how it becomes
// a GET /cookbook/meals query. Pure: no React, no router, no network, so the
// mapping is tested here and the screen (app/**, outside the test glob,
// D-WS9-164) only holds state and renders.
//
// The filters live in SCREEN state (they are a browse, not a preference), so
// nothing here persists.

export type CookbookSort = "popular" | "quickest" | "az";
export type TotalCap = 30 | 45 | 60;
export type ActiveCap = 15 | 20 | 30;
/** The UI difficulty. The server also says "hard" and stores "fancy". */
export type Difficulty = "easy" | "medium" | "hard";

export interface CookbookFilters {
  /** Canonical cuisine tokens (the server's CUISINE_TOKENS), any of. */
  cuisines: string[];
  maxMinutes: TotalCap | null;
  maxActiveMinutes: ActiveCap | null;
  difficulty: Difficulty[];
  highProtein: boolean;
  under600: boolean;
}

export const EMPTY_FILTERS: CookbookFilters = {
  cuisines: [],
  maxMinutes: null,
  maxActiveMinutes: null,
  difficulty: [],
  highProtein: false,
  under600: false,
};

export const TOTAL_CAPS: readonly TotalCap[] = [30, 45, 60];
export const ACTIVE_CAPS: readonly ActiveCap[] = [15, 20, 30];
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

/** The server refuses a one-character q (400); a shorter query is no query. */
export const MIN_QUERY_LENGTH = 2;
export const COOKBOOK_PAGE_SIZE = 30;

export const COOKBOOK_SORT_OPTIONS: ReadonlyArray<{ key: CookbookSort; label: string }> = [
  { key: "popular", label: "Popular" },
  { key: "quickest", label: "Quickest" },
  { key: "az", label: "A–Z" },
];

/** The search text as the server will see it, or null for "no query". */
export function effectiveQuery(text: string): string | null {
  const t = text.trim();
  return t.length >= MIN_QUERY_LENGTH ? t : null;
}

export interface CookbookQueryInput {
  q?: string;
  filters?: CookbookFilters;
  sort?: CookbookSort;
  /** A season or course tag (the collection view). */
  tag?: string | null;
  cursor?: string | null;
  limit?: number;
}

/**
 * The query string for GET /cookbook/meals. Keys in a fixed order so equal
 * inputs make equal strings (the string is part of the React Query key). A
 * default (no filter, popular sort) is omitted rather than sent.
 */
export function buildCookbookQuery(input: CookbookQueryInput): string {
  const f = input.filters ?? EMPTY_FILTERS;
  const parts: Array<[string, string]> = [];
  const q = input.q === undefined ? null : effectiveQuery(input.q);
  if (q !== null) parts.push(["q", q]);
  if (f.cuisines.length > 0) parts.push(["cuisine", [...f.cuisines].sort().join(",")]);
  if (f.maxMinutes !== null) parts.push(["maxMinutes", String(f.maxMinutes)]);
  if (f.maxActiveMinutes !== null) parts.push(["maxActiveMinutes", String(f.maxActiveMinutes)]);
  if (f.difficulty.length > 0) {
    // In DIFFICULTIES order, so ["hard","easy"] and ["easy","hard"] are one key.
    parts.push(["difficulty", DIFFICULTIES.filter((d) => f.difficulty.includes(d)).join(",")]);
  }
  if (f.highProtein) parts.push(["highProtein", "true"]);
  if (f.under600) parts.push(["maxCalories", "600"]);
  if (input.tag) parts.push(["tag", input.tag]);
  if (input.sort && input.sort !== "popular") parts.push(["sort", input.sort]);
  if (input.limit !== undefined) parts.push(["limit", String(input.limit)]);
  if (input.cursor) parts.push(["cursor", input.cursor]);
  return parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

/** The Filters button's badge: one per selected value. */
export function activeFilterCount(f: CookbookFilters): number {
  return (
    f.cuisines.length +
    (f.maxMinutes !== null ? 1 : 0) +
    (f.maxActiveMinutes !== null ? 1 : 0) +
    f.difficulty.length +
    (f.highProtein ? 1 : 0) +
    (f.under600 ? 1 : 0)
  );
}

export function hasAnyFilter(f: CookbookFilters): boolean {
  return activeFilterCount(f) > 0;
}

function toggleIn<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function toggleCuisine(f: CookbookFilters, token: string): CookbookFilters {
  return { ...f, cuisines: toggleIn(f.cuisines, token) };
}

export function toggleDifficulty(f: CookbookFilters, d: Difficulty): CookbookFilters {
  return { ...f, difficulty: toggleIn(f.difficulty, d) };
}

// ── the quick chips ─────────────────────────────────────────────────────────
//
// The chip row's shortcuts into the same filter state the sheet edits: a quick
// chip and its sheet row are one value, so toggling either shows on both.

export type QuickChip =
  | { kind: "time30"; label: string }
  | { kind: "easy"; label: string }
  | { kind: "protein"; label: string }
  | { kind: "cuisine"; label: string; token: string };

export const FIXED_QUICK_CHIPS: readonly QuickChip[] = [
  { kind: "time30", label: "≤ 30 min" },
  { kind: "easy", label: "Easy" },
  { kind: "protein", label: "High protein" },
];

export function isQuickOn(f: CookbookFilters, chip: QuickChip): boolean {
  switch (chip.kind) {
    case "time30":
      return f.maxMinutes === 30;
    case "easy":
      return f.difficulty.includes("easy");
    case "protein":
      return f.highProtein;
    case "cuisine":
      return f.cuisines.includes(chip.token);
  }
}

export function toggleQuick(f: CookbookFilters, chip: QuickChip): CookbookFilters {
  switch (chip.kind) {
    case "time30":
      return { ...f, maxMinutes: f.maxMinutes === 30 ? null : 30 };
    case "easy":
      return toggleDifficulty(f, "easy");
    case "protein":
      return { ...f, highProtein: !f.highProtein };
    case "cuisine":
      return toggleCuisine(f, chip.token);
  }
}

const CUISINE_LABELS: Record<string, string> = {
  bbq: "BBQ",
  "comfort-food": "Comfort food",
  "latin-american": "Latin American",
  "middle-eastern": "Middle Eastern",
  "soul-food": "Soul food",
  "tex-mex": "Tex-Mex",
};

/** "middle-eastern" → "Middle Eastern"; the server sends tokens, not labels. */
export function cuisineLabel(token: string): string {
  const known = CUISINE_LABELS[token];
  if (known) return known;
  return token
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The cuisine quick chips: the top `n` cuisines by count (the facet arrives
 * sorted by count), plus any cuisine the user has selected that fell outside
 * the top — a selected chip never disappears from the row while it is on.
 */
export function cuisineQuickChips(
  facet: ReadonlyArray<{ token: string; count: number }>,
  selected: readonly string[],
  n = 4,
): QuickChip[] {
  const top = facet.filter((c) => c.count > 0).slice(0, n).map((c) => c.token);
  const extra = selected.filter((t) => !top.includes(t));
  return [...top, ...extra].map((token) => ({ kind: "cuisine", label: cuisineLabel(token), token }));
}

// ── the card ────────────────────────────────────────────────────────────────

/** The stored difficulty as the card says it: "fancy" is Hard. */
export function difficultyLabel(stored: string): string {
  const d = stored.trim().toLowerCase();
  if (d === "fancy" || d === "hard") return "Hard";
  if (d === "easy") return "Easy";
  if (d === "medium") return "Medium";
  return stored;
}

/**
 * "47 min · 25 hands-on · 720 kcal". The minutes are the server's DERIVED
 * columns (never computed here); the hands-on part drops out when the meal has
 * no derived active time, and the kcal part when the figure is 0 (unknown).
 */
export function cardMetaLine(meal: {
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  macrosPerServing: { calories: number };
}): string {
  const parts = [`${meal.estimatedTimeMinutes} min`];
  if (meal.activeTimeMinutes !== null) parts.push(`${meal.activeTimeMinutes} hands-on`);
  const kcal = Math.round(meal.macrosPerServing.calories);
  if (kcal > 0) parts.push(`${kcal} kcal`);
  return parts.join(" · ");
}

/** The card's pills: the cuisine as written, then the difficulty label. */
export function cardPills(meal: { cuisineType: string | null; difficulty: string }): string[] {
  const out: string[] = [];
  const cuisine = meal.cuisineType?.trim();
  if (cuisine) out.push(cuisine);
  const diff = difficultyLabel(meal.difficulty);
  if (diff && diff.toLowerCase() !== cuisine?.toLowerCase()) out.push(diff);
  return out;
}

/** "1 meal" / "1,325 meals". */
export function mealCountLabel(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "meal" : "meals"}`;
}
