import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";

import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { SERVER_RECIPES, SERVER_RECIPE_IDS } from "../lib/recipeCatalog";

const router: IRouter = Router();

const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

const anthropic =
  baseURL && apiKey ? new Anthropic({ baseURL, apiKey }) : null;

const VALID_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type DayKey = (typeof VALID_DAYS)[number];
const VALID_SLOTS = ["Breakfast", "Lunch", "Dinner"] as const;
type SlotKey = (typeof VALID_SLOTS)[number];

interface GenerateRequest {
  prompt?: string;
  nights?: number;
  prefs?: {
    household?: number;
    diet?: string[];
    allergies?: string[];
    cuisines?: string[];
    cookSkill?: string;
  };
  pantry?: string[];
}

interface GeneratedSlot {
  day: DayKey;
  slot: SlotKey;
  recipeId: string;
  reason?: string;
}

interface GeneratedPlan {
  name: string;
  notes: string;
  meals: GeneratedSlot[];
}

const SYSTEM_PROMPT = `You are Kiwi, a warm, practical meal-planning assistant.
Given a list of available recipes and the user's preferences, build a weekly dinner plan.

You MUST respond with ONLY valid JSON in this exact shape — no prose, no markdown fences:
{
  "name": "short plan name (max 5 words)",
  "notes": "one friendly sentence about why this plan fits",
  "meals": [
    { "day": "Mon", "slot": "Dinner", "recipeId": "<id from catalog>", "reason": "short why" }
  ]
}

Rules:
- Use ONLY recipeIds present in the provided catalog.
- Days must be from: Mon, Tue, Wed, Thu, Fri, Sat, Sun (in that weekday order).
- Slot must be one of: Breakfast, Lunch, Dinner. Default to "Dinner" unless asked otherwise.
- Vary cuisines and ingredients across the week.
- Respect dietary restrictions and allergies strictly.
- If pantry items are listed, prefer recipes that reuse them.
- Generate exactly the number of nights requested.`;

const limiter = rateLimit({ capacity: 8, refillPerSec: 8 / 60 }); // 8 burst, ~1 every 7.5s

router.post("/plans/generate", limiter, async (req, res) => {
  const body = (req.body ?? {}) as GenerateRequest;
  const nights = Math.min(7, Math.max(1, Number(body.nights) || 5));
  const prefs = body.prefs ?? {};
  // Sanitize text fields so prompt-injected payloads don't go straight to the model
  const prompt = sanitizeText(body.prompt, 500);
  const pantry = (body.pantry ?? [])
    .filter((p): p is string => typeof p === "string")
    .map((p) => sanitizeText(p, 60))
    .filter(Boolean)
    .slice(0, 50);

  if (!anthropic) {
    logger.warn("Anthropic not configured, returning deterministic fallback plan");
    return res.json(buildFallbackPlan(nights));
  }

  const userMessage = JSON.stringify(
    {
      prompt: prompt || "Build me a balanced week of dinners.",
      nights,
      household: clampInt(prefs.household, 1, 12, 2),
      diet: cleanStrArr(prefs.diet, 12, 40),
      allergies: cleanStrArr(prefs.allergies, 12, 40),
      preferredCuisines: cleanStrArr(prefs.cuisines, 12, 40),
      cookSkill: sanitizeText(prefs.cookSkill, 30) || "intermediate",
      pantry,
      recipes: SERVER_RECIPES, // server-authoritative catalog
    },
    null,
    2,
  );

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    const cleaned = stripFences(text).trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      logger.error({ err, text: cleaned }, "Failed to parse plan JSON");
      return res.json(buildFallbackPlan(nights));
    }

    const plan = normalizePlan(parsed, nights);
    if (!plan) return res.json(buildFallbackPlan(nights));
    return res.json(plan);
  } catch (err) {
    logger.error({ err }, "Anthropic plan generation failed");
    return res.json(buildFallbackPlan(nights));
  }
});

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function sanitizeText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function cleanStrArr(v: unknown, maxLen: number, maxItem: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => sanitizeText(x, maxItem))
    .filter(Boolean)
    .slice(0, maxLen);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizePlan(raw: unknown, nights: number): GeneratedPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const meals = Array.isArray(obj.meals) ? obj.meals : [];

  const valid: GeneratedSlot[] = [];
  for (const m of meals) {
    if (!m || typeof m !== "object") continue;
    const slot = (m as Record<string, unknown>).slot;
    const day = (m as Record<string, unknown>).day;
    const recipeId = (m as Record<string, unknown>).recipeId;
    const reason = (m as Record<string, unknown>).reason;

    if (typeof recipeId !== "string" || !SERVER_RECIPE_IDS.has(recipeId)) continue;
    const safeSlot: SlotKey = VALID_SLOTS.includes(slot as SlotKey)
      ? (slot as SlotKey)
      : "Dinner";
    const safeDay: DayKey = VALID_DAYS.includes(day as DayKey)
      ? (day as DayKey)
      : VALID_DAYS[valid.length % 7];

    valid.push({
      day: safeDay,
      slot: safeSlot,
      recipeId,
      reason: typeof reason === "string" ? sanitizeText(reason, 140) : undefined,
    });
    if (valid.length >= nights) break;
  }

  if (valid.length === 0) return null;

  // Top up if model returned fewer than requested
  while (valid.length < nights) {
    const idx = valid.length;
    const dayIdx = idx % 7;
    const recipeId = SERVER_RECIPES[idx % SERVER_RECIPES.length].id;
    valid.push({
      day: VALID_DAYS[dayIdx],
      slot: "Dinner",
      recipeId,
    });
  }

  // Force weekday order so UI can render predictably
  valid.sort(
    (a, b) => VALID_DAYS.indexOf(a.day) - VALID_DAYS.indexOf(b.day),
  );

  return {
    name: sanitizeText(obj.name, 60) || `${nights}-night plan`,
    notes:
      sanitizeText(obj.notes, 200) ||
      "A balanced rotation built around your preferences.",
    meals: valid,
  };
}

function buildFallbackPlan(nights: number): GeneratedPlan {
  return {
    name: `${nights}-night plan`,
    notes: "A balanced rotation of your saved recipes.",
    meals: Array.from({ length: nights }).map((_, i) => ({
      day: VALID_DAYS[i % 7],
      slot: "Dinner",
      recipeId: SERVER_RECIPES[i % SERVER_RECIPES.length].id,
      reason: "Variety pick",
    })),
  };
}

export default router;
