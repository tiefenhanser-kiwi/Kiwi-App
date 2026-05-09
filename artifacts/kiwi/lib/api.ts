// Tiny API client for the Kiwi Express server (artifacts/api-server).
// Targets /api/* — uses the public Replit dev domain so the app can reach
// the api-server from inside the Expo Go iframe / native devices.
//
// Per-feature API modules now live under ./api/. This file remains for
// stand-alone helpers that don't fit a feature module.

import { readToken } from "./auth";

// Convention: apiBase includes /api. Endpoint paths do NOT prefix /api.
const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");

export interface ScaleIngredient {
  name: string;
  amount: string;
}

export async function scaleIngredients(input: {
  recipeTitle: string;
  fromServings: number;
  toServings: number;
  ingredients: ScaleIngredient[];
}): Promise<ScaleIngredient[]> {
  const url = `${apiBase}/recipes/scale`;
  const token = await readToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Scaling failed (${res.status})`);
  }
  const data = (await res.json()) as { scaled: ScaleIngredient[] };
  return data.scaled;
}

// Re-export the wizard call so existing import sites that go through this
// module still work. New code should import from "./api/wizard" directly.
export { buildWizardPlans } from "./api/wizard";
