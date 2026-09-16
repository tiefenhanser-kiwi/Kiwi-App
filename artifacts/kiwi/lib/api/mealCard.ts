// WS9 Redesign Arc Block 2a — the Pick-screen / Playlist card projection, ONE
// Zod for the shape both POST /wizard/shelf and GET /me/playlist ship
// (transcribed from artifacts/api-server/src/lib/store/mealCard.ts, D-WS9-237).
//
// Times are the server's DERIVED columns (D-WS9-235): `estimatedTimeMinutes`
// is the total, `activeTimeMinutes` the active — null when the meal was never
// derived. The client renders what it is sent and computes NO minutes itself.

import { z } from "zod";

export const MealCardSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    cuisineType: z.string().nullable(),
    difficulty: z.string(),
    estimatedTimeMinutes: z.number(),
    activeTimeMinutes: z.number().nullable(),
    macrosPerServing: z.object({
      calories: z.number(),
      protein: z.number(),
      carbs: z.number(),
      fat: z.number(),
    }),
    tags: z.array(z.string()),
    dishCount: z.number(),
  })
  .passthrough();
export type MealCard = z.infer<typeof MealCardSchema>;
