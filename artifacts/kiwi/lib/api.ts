// Tiny API client for the Kiwi Express server (artifacts/api-server).
// Targets /api/* — uses the public Replit dev domain so the app can reach
// the api-server from inside the Expo Go iframe / native devices.

import { DayKey, MealSlot } from "./mockData";
import type { UserPrefs } from "@/contexts/AppContext";

const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "");

export interface GeneratedPlanResponse {
  name: string;
  notes: string;
  meals: Array<{
    day: DayKey;
    slot: MealSlot["slot"];
    recipeId: string;
    reason?: string;
  }>;
}

export interface GeneratePlanInput {
  prompt?: string;
  nights: number;
  prefs: UserPrefs;
  pantry: string[];
}

export async function generatePlan(
  input: GeneratePlanInput,
): Promise<GeneratedPlanResponse> {
  const url = `${apiBase}/api/plans/generate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      nights: input.nights,
      prefs: {
        household: input.prefs.household,
        diet: input.prefs.diet,
        allergies: input.prefs.allergies,
        cuisines: input.prefs.cuisines,
        cookSkill: input.prefs.cookSkill,
      },
      pantry: input.pantry,
    }),
  });
  if (!res.ok) {
    throw new Error(`Plan generation failed (${res.status})`);
  }
  return (await res.json()) as GeneratedPlanResponse;
}
