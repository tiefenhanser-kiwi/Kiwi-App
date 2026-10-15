// BOOK-1C1 (D-WS9-312) — the in-app Cookbook's two reads.
//
//   GET /cookbook/meals    — browse + search the public catalog (BOOK-1S),
//                            plus the filter-sheet params BOOK-1C1 added.
//   GET /cookbook/seasons  — the promotional collections in their window now.
//
// Schemas transcribed from artifacts/api-server/src/lib/cookbook/{search,
// seasons}.ts. The card is the shared MealCardSchema (passthrough, so
// displayTitle rides along) plus the two save flags. The query string is built
// by lib/cookbook/query.ts (pure, tested); this module only fetches.

import { z } from "zod";

import { apiClient } from "./client";
import { MealCardSchema } from "./mealCard";

export const CookbookMealSchema = MealCardSchema.extend({
  displayTitle: z.string().nullable().optional(),
  /** The heart ("Save to My Meals"): a Favorite on this meal or the user's copy. */
  isSaved: z.boolean(),
  /** On the Playlist (by lineage). Optional: a pre-BOOK-1C1 server omits it. */
  isInPlaylist: z.boolean().optional(),
});
export type CookbookMeal = z.infer<typeof CookbookMealSchema>;

const CookbookFacetsSchema = z
  .object({
    cuisines: z.array(z.object({ token: z.string(), count: z.number() })),
    thanksgiving: z.number(),
    // BOOK-1C1 facets — optional so a pre-1C1 server still validates.
    difficulty: z
      .object({ easy: z.number(), medium: z.number(), hard: z.number() })
      .optional(),
    activeMinutes: z
      .object({ "15": z.number(), "20": z.number(), "30": z.number() })
      .optional(),
    highProtein: z.number().optional(),
    under600: z.number().optional(),
  })
  .passthrough();
export type CookbookFacets = z.infer<typeof CookbookFacetsSchema>;

const CookbookPageSchema = z.object({
  meals: z.array(CookbookMealSchema),
  total: z.number(),
  nextCursor: z.string().nullable(),
  facets: CookbookFacetsSchema,
});
export type CookbookPage = z.infer<typeof CookbookPageSchema>;

/** GET /cookbook/meals?<queryString> — the string comes from buildCookbookQuery. */
export async function searchCookbook(queryString: string): Promise<CookbookPage> {
  return apiClient(`/cookbook/meals${queryString ? `?${queryString}` : ""}`, {
    schema: CookbookPageSchema,
  });
}

export const SeasonSchema = z.object({
  tag: z.string(),
  label: z.string(),
  headline: z.string(),
  blurb: z.string(),
  /** The collection's bottom bar (→ Featured plans); null = no bar. */
  featuredNote: z.string().nullable().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** The last day, "YYYY-MM-DD" ("until Nov 30"). */
  endsOn: z.string(),
  count: z.number(),
  courses: z.array(z.object({ label: z.string(), tag: z.string(), count: z.number() })),
});
export type Season = z.infer<typeof SeasonSchema>;

const SeasonsResponseSchema = z.object({
  /** The instant the server evaluated the windows at (its clock, not ours). */
  asOf: z.string(),
  seasons: z.array(SeasonSchema),
});
export type SeasonsResponse = z.infer<typeof SeasonsResponseSchema>;

/** GET /cookbook/seasons. */
export async function getCookbookSeasons(): Promise<SeasonsResponse> {
  return apiClient("/cookbook/seasons", { schema: SeasonsResponseSchema });
}
