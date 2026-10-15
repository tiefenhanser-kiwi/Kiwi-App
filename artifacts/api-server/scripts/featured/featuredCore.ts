// THX-1 — the pure half of the Featured-rail data script. No database, no I/O:
// applyFeaturedTemplates.ts and revertFeaturedTemplates.ts do the reads and
// writes, and featuredCore.test.ts pins every rule here.
//
// A rail template (FEAT-0 §I) is five Monday–Friday dinner items, no servings
// (the household size wins at use time), and its own imageUrl — copied from
// the plan's cover meal, because the rail card reads MealPlanTemplate.imageUrl
// and nothing else (planQueries.ts RAIL_SELECT).

export const FEATURED_ID_PREFIX = "featured-";
export const SEED_ID_PREFIX = "dev-plan-template-";
export const TITLE_MAX = 42;
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
export const MAX_PER_CUISINE = 2;
/** planQueries.ts RAIL_LIMIT — a spec longer than the rail would hide its tail. */
export const MAX_PLANS = 12;

/**
 * The editorial owner. MealPlanTemplate.userId is required, and the seeds'
 * owner (the dev user) does not exist on production.
 *
 * Keyed on a FIXED id, never on the email: an upsert by email would silently
 * adopt any real account that already holds the address. The apply refuses
 * if the email belongs to a different id.
 *
 * `accountStatus: blocked` is what makes "nobody can sign in as it" true.
 * Without it, two paths reach this row with no password at all:
 *   - POST /auth/password-reset/request mails a working link to the address
 *     (routes/auth.ts:915-963), and
 *   - OAuth links a verified provider email to the existing row
 *     (lib/oauth/resolve.ts:171-203).
 * Password login (auth.ts:478), OAuth sign-in (:730) and reset-confirm (:980)
 * all refuse a non-active account, so a blocked row mints no token by any
 * route. (me.ts:18-21 calls the column WRITE-NEVER for ROUTES; this is a data
 * script stamping a non-human row, and the three readers stay as they are.)
 *
 * `signupSource: "editorial"` gives any future real-accounts count one
 * explicit marker to exclude.
 */
export const OWNER = {
  id: "kiwi-kitchen-editorial",
  email: "kitchen@kitchenwizard.ai",
  firstName: "Kiwi",
  lastName: "Kitchen",
  accountStatus: "blocked",
  subscriptionStatus: "none",
  signupSource: "editorial",
} as const;

export interface SpecDay {
  day: string;
  /** The meal by id — or by `thx2Key` (exactly one of the two). */
  mealId: string;
  /**
   * THX-2S — a THX-2G meal by its key (Meal.dishFamilyKey on a batch_generated
   * row, the way scripts/thx2/ records it). Resolved to `mealId` before any
   * check runs (resolveThx2Keys).
   */
  thx2Key?: string;
  /** THX-2S — copied onto the adopted plan item (the feast at 10). Absent = household. */
  servingsOverride?: number;
  /** For the reader of the JSON only; the script prints the database title. */
  name?: string;
}

export interface SpecPlan {
  slug: string;
  title: string;
  description: string;
  /** Defaults to the first day's meal. */
  coverMealId?: string;
  /**
   * THX-2S (D-WS9-311) — "YYYY-MM-DD", the Thursday a dated plan is built
   * around (MealPlanTemplate.anchorDate). Requires `featuredUntil`.
   */
  anchorDate?: string;
  /**
   * THX-2S — the featuring window: MealPlanTemplate.featuredStartDate /
   * featuredEndDate, both inclusive and compared against the instant `now` by
   * the rail and the Featured chip (lib/featuring.ts). A ZONED ISO instant
   * ("2026-11-02T05:00:00Z", "2026-11-26T23:59:59-10:00"): a bare date would
   * end the window at 00:00 UTC, the evening before in the US.
   */
  featuredFrom?: string;
  featuredUntil?: string;
  days: SpecDay[];
}

export interface Spec {
  plans: SpecPlan[];
}

/** The meal columns the checks read. */
export interface MealCheckRow {
  id: string;
  title: string;
  cuisineType: string | null;
  isPublic: boolean;
  isArchived: boolean;
  imageUrl: string | null;
  activeTimeMinutes: number | null;
  userId: string | null;
}

export const templateIdFor = (slug: string): string => `${FEATURED_ID_PREFIX}${slug}`;
export const coverMealIdFor = (p: SpecPlan): string => p.coverMealId ?? p.days[0]?.mealId;

// ── THX-2S — the Thanksgiving fields ─────────────────────────────────────────

export const THX2_KEY_RE = /^thx2-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * The latest a dated plan may stay featured: the end of its anchor day in the
 * westernmost US zone (Hawaii, UTC−10) — anchor + 1 day + 10 h. After the
 * anchor, adoption no longer dates the plan (lib/templateAnchor.ts), so the
 * rail must not still be offering it.
 */
export const ANCHOR_WINDOW_GRACE_MS = (24 + 10) * 3_600_000;

/** "YYYY-MM-DD" → that day at UTC midnight (the @db.Date basis), or null. */
export function parseYmd(v: unknown): Date | null {
  if (typeof v !== "string" || !YMD_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

function parseInstant(v: unknown): Date | null {
  if (typeof v !== "string" || !ZONED_INSTANT_RE.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Every problem with the THX-2S fields (keys, servings, anchor, window). */
export function validateThanksgivingFields(spec: Spec): string[] {
  const out: string[] = [];
  for (const [i, p] of (spec?.plans ?? []).entries()) {
    const label = p?.slug ? `"${p.slug}"` : `plan #${i + 1}`;
    for (const d of Array.isArray(p?.days) ? p.days : []) {
      const at = `${label} ${d?.day ?? "a day"}`;
      if (d?.mealId && d?.thx2Key) out.push(`${at}: give mealId OR thx2Key, not both`);
      if (d?.thx2Key !== undefined && !THX2_KEY_RE.test(String(d.thx2Key))) {
        out.push(`${at}: thx2Key "${d.thx2Key}" is not a thx2- key`);
      }
      if (
        d?.servingsOverride !== undefined &&
        (!Number.isInteger(d.servingsOverride) || d.servingsOverride < 1 || d.servingsOverride > 30)
      ) {
        out.push(`${at}: servingsOverride must be an integer 1–30 (got ${JSON.stringify(d.servingsOverride)})`);
      }
    }
    const from = p?.featuredFrom === undefined ? null : parseInstant(p.featuredFrom);
    const until = p?.featuredUntil === undefined ? null : parseInstant(p.featuredUntil);
    if (p?.featuredFrom !== undefined && !from) {
      out.push(`${label}: featuredFrom must be a zoned ISO instant (got ${JSON.stringify(p.featuredFrom)})`);
    }
    if (p?.featuredUntil !== undefined && !until) {
      out.push(`${label}: featuredUntil must be a zoned ISO instant (got ${JSON.stringify(p.featuredUntil)})`);
    }
    if (from && until && from.getTime() > until.getTime()) out.push(`${label}: featuredFrom is after featuredUntil`);
    if (p?.anchorDate !== undefined) {
      const anchor = parseYmd(p.anchorDate);
      if (!anchor) {
        out.push(`${label}: anchorDate must be YYYY-MM-DD (got ${JSON.stringify(p.anchorDate)})`);
      } else if (p.featuredUntil === undefined) {
        out.push(`${label}: a dated plan needs featuredUntil (it must leave the rail after its anchor)`);
      } else if (until && until.getTime() > anchor.getTime() + ANCHOR_WINDOW_GRACE_MS) {
        const latest = new Date(anchor.getTime() + ANCHOR_WINDOW_GRACE_MS).toISOString();
        out.push(`${label}: featuredUntil ${p.featuredUntil} outlives the anchor ${p.anchorDate} (latest ${latest})`);
      }
    }
  }
  return out;
}

/**
 * Fill each `thx2Key` day's mealId from `idByKey` (key → Meal.id, from the
 * database). Returns a NEW spec and one error per unresolved key.
 */
export function resolveThx2Keys(
  spec: Spec,
  idByKey: ReadonlyMap<string, string>,
): { spec: Spec; errors: string[] } {
  const errors: string[] = [];
  const plans = spec.plans.map((p) => ({
    ...p,
    days: p.days.map((d) => {
      if (!d.thx2Key) return d;
      const id = idByKey.get(d.thx2Key);
      if (!id) {
        errors.push(`"${p.slug}" ${d.day}: thx2Key ${d.thx2Key} is not on this database`);
        return d;
      }
      return { ...d, mealId: id };
    }),
  }));
  return { spec: { ...spec, plans }, errors };
}

/** The keys a spec names, for one database read. */
export const thx2KeysOf = (spec: Spec): string[] => [
  ...new Set(spec.plans.flatMap((p) => p.days.map((d) => d.thx2Key).filter((k): k is string => !!k))),
];

/** Every structural problem in the spec, not just the first. */
export function validateSpec(spec: Spec): string[] {
  const out: string[] = [];
  if (!spec || !Array.isArray(spec.plans) || spec.plans.length === 0) {
    return ["spec: `plans` must be a non-empty array"];
  }
  if (spec.plans.length > MAX_PLANS) {
    out.push(`spec: ${spec.plans.length} plans, but the rail shows at most ${MAX_PLANS}`);
  }
  const slugs = new Set<string>();
  const mealOwner = new Map<string, string>();
  for (const [i, p] of spec.plans.entries()) {
    const label = p?.slug ? `"${p.slug}"` : `plan #${i + 1}`;
    if (!p?.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) {
      out.push(`${label}: slug must be lowercase kebab-case`);
    } else if (slugs.has(p.slug)) {
      out.push(`${label}: slug appears twice`);
    } else {
      slugs.add(p.slug);
    }
    const title = (p?.title ?? "").trim();
    if (!title) out.push(`${label}: title is empty`);
    if (title.length > TITLE_MAX) {
      out.push(`${label}: title is ${title.length} characters (max ${TITLE_MAX})`);
    }
    if (!(p?.description ?? "").trim()) out.push(`${label}: description is empty`);

    const days = Array.isArray(p?.days) ? p.days : [];
    if (days.length !== WEEKDAYS.length) {
      out.push(`${label}: ${days.length} days (exactly ${WEEKDAYS.length}, Monday–Friday)`);
    }
    days.forEach((d, j) => {
      if (j < WEEKDAYS.length && d?.day !== WEEKDAYS[j]) {
        out.push(`${label}: day ${j + 1} is "${d?.day}" (expected ${WEEKDAYS[j]})`);
      }
    });
    const inPlan = new Set<string>();
    for (const d of days) {
      if (!d?.mealId) {
        out.push(`${label}: ${d?.day ?? "a day"} has no mealId`);
        continue;
      }
      if (inPlan.has(d.mealId)) out.push(`${label}: meal ${d.mealId} appears twice in the plan`);
      inPlan.add(d.mealId);
      const other = mealOwner.get(d.mealId);
      if (other && other !== p.slug) {
        out.push(`${label}: meal ${d.mealId} is already in "${other}" (no meal in two plans)`);
      } else {
        mealOwner.set(d.mealId, p.slug);
      }
    }
    if (p?.coverMealId && !inPlan.has(p.coverMealId)) {
      out.push(`${label}: coverMealId ${p.coverMealId} is not one of the plan's meals`);
    }
  }
  return out;
}

/**
 * The abort rule. Every meal the spec names must exist, be public, not be
 * archived, carry an image and a derived active time — and be catalog-owned:
 * template items RESTRICT the meal's deletion, so a user-owned meal on a
 * template would make that user's DELETE /me fail (me.ts:1473 against
 * meal_plan_template_items.mealId ON DELETE RESTRICT). Then no plan may hold
 * more than two meals of one cuisine.
 *
 * Returns EVERY failure. An empty list is the only thing that lets a write
 * happen.
 */
export function checkMeals(spec: Spec, rows: readonly MealCheckRow[]): string[] {
  const out: string[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const reported = new Set<string>();
  for (const p of spec.plans) {
    const cuisines = new Map<string, number>();
    for (const d of p.days) {
      const m = byId.get(d.mealId);
      const who = `"${p.slug}" ${d.day} ${d.mealId}`;
      if (!m) {
        out.push(`${who}${d.name ? ` (${d.name})` : ""}: meal does not exist on this database`);
        continue;
      }
      if (!reported.has(m.id)) {
        reported.add(m.id);
        if (!m.isPublic) out.push(`${who} "${m.title}": not public`);
        if (m.isArchived) out.push(`${who} "${m.title}": archived`);
        if (!m.imageUrl) out.push(`${who} "${m.title}": no image`);
        if (m.activeTimeMinutes == null) out.push(`${who} "${m.title}": activeTimeMinutes is null`);
        if (m.userId != null) out.push(`${who} "${m.title}": owned by user ${m.userId} (catalog meals only)`);
      }
      // THX-2S (D-WS9-311, THX-2-0 call 5) — in a dated (Thanksgiving) plan
      // the feast and the leftovers day are exempt from the cuisine cap.
      if (p.anchorDate && (d.day === "Thursday" || d.day === "Friday")) continue;
      const c = (m.cuisineType ?? "").trim();
      if (c) cuisines.set(c, (cuisines.get(c) ?? 0) + 1);
    }
    for (const [c, n] of cuisines) {
      if (n > MAX_PER_CUISINE) out.push(`"${p.slug}": ${n} meals are ${c} (max ${MAX_PER_CUISINE} per cuisine)`);
    }
  }
  return out;
}

// ── desired rows ─────────────────────────────────────────────────────────────

export interface TemplateFields {
  userId: string;
  title: string;
  description: string;
  displayTitle: string | null;
  sourceType: "curated";
  defaultDaysCount: number;
  tags: string[];
  imageUrl: string | null;
  isArchived: boolean;
  isPublic: boolean;
  isFeatured: boolean;
  isHostingFeatured: boolean;
  featuredRank: number | null;
  hostingFeaturedRank: number | null;
  featuredStartDate: Date | null;
  featuredEndDate: Date | null;
  railPosition: number | null;
  occasionType: string | null;
  /** THX-2S — null on every everyday plan. */
  anchorDate: Date | null;
}

export interface ItemFields {
  mealId: string;
  positionIndex: number;
  assignedDayOfWeek: string | null;
  /** THX-2S — null = the household size (every everyday item). */
  servingsOverride: number | null;
  isBreakfast: boolean;
  isLunch: boolean;
  isDinner: boolean;
}

/**
 * The template row for spec plan `index`. `title` is the column every card
 * reads (planQueries.ts TEMPLATE_SELECT / RAIL_SELECT; GET /plans/templates/:id);
 * no template path reads `displayTitle`, so it is written null.
 */
export function desiredTemplate(p: SpecPlan, index: number, coverImageUrl: string | null): TemplateFields {
  return {
    userId: OWNER.id,
    title: p.title.trim(),
    description: p.description.trim(),
    displayTitle: null,
    sourceType: "curated",
    defaultDaysCount: WEEKDAYS.length,
    tags: [],
    imageUrl: coverImageUrl,
    isArchived: false,
    isPublic: true,
    isFeatured: true,
    isHostingFeatured: false,
    featuredRank: null,
    hostingFeaturedRank: null,
    featuredStartDate: p.featuredFrom ? new Date(p.featuredFrom) : null,
    featuredEndDate: p.featuredUntil ? new Date(p.featuredUntil) : null,
    railPosition: index + 1,
    occasionType: null,
    anchorDate: p.anchorDate ? parseYmd(p.anchorDate) : null,
  };
}

export function desiredItems(p: SpecPlan): ItemFields[] {
  return p.days.map((d, i) => ({
    mealId: d.mealId,
    positionIndex: i,
    assignedDayOfWeek: d.day,
    servingsOverride: d.servingsOverride ?? null,
    isBreakfast: false,
    isLunch: false,
    isDinner: true,
  }));
}

/** The values a retired seed carries. */
export const RETIRED_SEED = {
  isArchived: true,
  railPosition: null,
  isFeatured: false,
  isHostingFeatured: false,
} as const;

/** The values a reverted featured template carries. */
export const REVERTED_FEATURED = {
  isArchived: true,
  railPosition: null,
  isFeatured: false,
  isHostingFeatured: false,
} as const;

// ── diffing ──────────────────────────────────────────────────────────────────

const norm = (v: unknown): unknown =>
  v instanceof Date ? v.toISOString() : Array.isArray(v) ? JSON.stringify(v) : v ?? null;

/** `field: before -> after` for every field of `want` that `have` does not already carry. */
export function fieldChanges(have: object | null, want: object): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    const before = have ? (have as Record<string, unknown>)[k] : undefined;
    if (norm(before) !== norm(v)) out.push(`${k}: ${JSON.stringify(norm(before))} -> ${JSON.stringify(norm(v))}`);
  }
  return out;
}

export function sameItems(have: readonly ItemFields[], want: readonly ItemFields[]): boolean {
  const key = (i: ItemFields) =>
    [i.positionIndex, i.assignedDayOfWeek, i.mealId, i.servingsOverride ?? null, i.isBreakfast, i.isLunch, i.isDinner].join("|");
  const a = [...have].map(key).sort();
  const b = [...want].map(key).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
