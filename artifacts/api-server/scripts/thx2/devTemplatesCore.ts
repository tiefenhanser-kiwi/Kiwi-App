// SERVER-10 G (D-WS9-349) — the pure half of seedDevTemplates.ts: the dev spec's
// days resolved to meals, and the template rows they make. No database here.
//
// The rows are featuredCore's own (desiredTemplate / desiredItems: the shapes
// applyFeaturedTemplates writes on production) with ONE dev-only difference,
// DEV_ALSO_FEATURED: production lists these plans on the Hosting & events chip
// only (featured: false), and the night run's households reach a template
// through the Featured chip (scripts/qa-night/journeys.ts, GET
// /plans?filter=featured). So on dev they are on both chips; railPosition stays
// null, so the Home rail (railPosition, not the flag) is unchanged.

import { desiredItems, desiredTemplate, templateIdFor, type ItemFields, type SpecPlan, type TemplateFields } from "../featured/featuredCore";

export interface DevDay {
  day: string;
  /** The same catalog meal as production, by id … */
  mealId?: string;
  /** … or a dev meal by its Meal.dishFamilyKey (prodcopy:thx2-feast-*, thx2-friday-*). */
  dishFamilyKey?: string;
  servingsOverride?: number;
  name?: string;
}

export interface DevPlan extends Omit<SpecPlan, "days" | "coverMealId"> {
  /** The day whose meal's image is the cover (the feast). */
  coverDay: string;
  days: DevDay[];
}

export interface DevSpec {
  plans: DevPlan[];
}

/** The dev-only difference from production (see the header). */
export const DEV_ALSO_FEATURED = { isFeatured: true } as const;

/** The meals a day can resolve to: id, and dishFamilyKey when it has one. */
export interface DevMealRow {
  id: string;
  dishFamilyKey: string | null;
  imageUrl: string | null;
  isArchived: boolean;
}

/** Each day's meal id, or every problem (a missing meal, an ambiguous key, an archived meal). */
export function resolveDays(spec: DevSpec, meals: readonly DevMealRow[]): { mealIdOf: Map<string, string>; problems: string[] } {
  const mealIdOf = new Map<string, string>();
  const problems: string[] = [];
  for (const p of spec.plans) {
    for (const d of p.days) {
      const at = `${p.slug} ${d.day}`;
      if (!!d.mealId === !!d.dishFamilyKey) { problems.push(`${at}: name exactly one of mealId and dishFamilyKey`); continue; }
      const hits = d.mealId ? meals.filter((m) => m.id === d.mealId) : meals.filter((m) => m.dishFamilyKey === d.dishFamilyKey);
      if (hits.length === 0) { problems.push(`${at}: no meal ${d.mealId ?? d.dishFamilyKey} on this database`); continue; }
      if (hits.length > 1) { problems.push(`${at}: ${hits.length} meals carry ${d.dishFamilyKey}`); continue; }
      if (hits[0].isArchived) { problems.push(`${at}: meal ${hits[0].id} is archived`); continue; }
      mealIdOf.set(at, hits[0].id);
    }
  }
  return { mealIdOf, problems };
}

export interface DevTemplateRows {
  id: string;
  want: TemplateFields;
  items: ItemFields[];
}

/** The template and item rows for every plan. Call after resolveDays reported no problem. */
export function devTemplateRows(spec: DevSpec, mealIdOf: ReadonlyMap<string, string>, meals: readonly DevMealRow[]): DevTemplateRows[] {
  return spec.plans.map((p, i) => {
    const plan: SpecPlan = {
      ...p,
      days: p.days.map((d) => ({ day: d.day, mealId: mealIdOf.get(`${p.slug} ${d.day}`)!, ...(d.servingsOverride ? { servingsOverride: d.servingsOverride } : {}) })),
    };
    const cover = mealIdOf.get(`${p.slug} ${p.coverDay}`);
    const image = meals.find((m) => m.id === cover)?.imageUrl ?? null;
    return { id: templateIdFor(p.slug), want: { ...desiredTemplate(plan, i, image), ...DEV_ALSO_FEATURED }, items: desiredItems(plan) };
  });
}
