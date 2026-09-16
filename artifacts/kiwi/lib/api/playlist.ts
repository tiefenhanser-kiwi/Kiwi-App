// Mobile client for GET /me/playlist (WS9 Redesign Arc Block 1 D, D-WS9-234).
//
// Block 2a needs only the COUNT: it gates the Playlist dial (a user with zero
// playlist meals sees the nudge card in place of the chips, on the preferences
// screen and in the merged wizard). Block 2b (the Playlist tab, add / remove)
// extends this file; the list shape is already the shared MealCard so that
// block adds calls, not schemas.

import { z } from "zod";

import { apiClient } from "./client";
import { MealCardSchema } from "./mealCard";

const PlaylistMealSchema = MealCardSchema.extend({
  isPlaylist: z.literal(true),
  isNewToYou: z.literal(false),
  source: z.literal("playlist"),
  addedAt: z.string(),
});
export type PlaylistMeal = z.infer<typeof PlaylistMealSchema>;

const GetPlaylistResponseSchema = z.object({
  playlist: z.array(PlaylistMealSchema),
  count: z.number().int().nonnegative(),
});
export type GetPlaylistResponse = z.infer<typeof GetPlaylistResponseSchema>;

/** React Query key for the user's playlist — one family, invalidated by 2b's writes. */
export const PLAYLIST_QUERY_KEY = ["me", "playlist"] as const;

/**
 * GET /me/playlist — the user's playlist meals, newest first, with `count`.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (500), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getPlaylist(): Promise<GetPlaylistResponse> {
  return apiClient("/me/playlist", { schema: GetPlaylistResponseSchema });
}
