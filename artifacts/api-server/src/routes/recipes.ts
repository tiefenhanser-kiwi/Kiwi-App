import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";

import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";

const router: IRouter = Router();

const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

const anthropic =
  baseURL && apiKey ? new Anthropic({ baseURL, apiKey }) : null;

interface ScaleIngredient {
  name: string;
  amount: string;
}

interface ScaleRequest {
  recipeTitle?: string;
  fromServings?: number;
  toServings?: number;
  ingredients?: ScaleIngredient[];
}

interface ScaleResponse {
  scaled: ScaleIngredient[];
}

const SYSTEM_PROMPT = `You are a culinary assistant that scales recipe ingredients.
Given a list of ingredients with original amounts and a scaling factor, return new amounts.

Rules:
- Round to friendly cooking measures (e.g. "1 1/2 cups" not "1.5 cups", "3 tbsp" not "2.83 tbsp").
- For "1 can", "1 jar", "1 head" style items, round up to whole units.
- Keep ingredient name unchanged.
- Reply with ONLY valid JSON: { "scaled": [ { "name": "...", "amount": "..." } ] } — no prose, no markdown.`;

const limiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 });

router.post("/recipes/scale", limiter, async (req, res) => {
  const body = (req.body ?? {}) as ScaleRequest;
  const fromServings = clampInt(body.fromServings, 1, 20, 2);
  const toServings = clampInt(body.toServings, 1, 20, 2);
  const ingredients = (body.ingredients ?? [])
    .filter(
      (i): i is ScaleIngredient =>
        !!i && typeof i.name === "string" && typeof i.amount === "string",
    )
    .map((i) => ({
      name: i.name.slice(0, 80),
      amount: i.amount.slice(0, 40),
    }))
    .slice(0, 30);

  if (ingredients.length === 0) {
    return res.status(400).json({ error: "ingredients required" });
  }

  if (toServings === fromServings) {
    return res.json({ scaled: ingredients });
  }

  if (!anthropic) {
    return res.json({ scaled: linearFallback(ingredients, fromServings, toServings) });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            recipeTitle: body.recipeTitle?.slice(0, 100) ?? "",
            fromServings,
            toServings,
            ingredients,
          }),
        },
      ],
    });

    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as ScaleResponse;
    if (!Array.isArray(parsed.scaled) || parsed.scaled.length === 0) {
      throw new Error("empty scaled");
    }

    // Align positionally — keying by name collapses duplicates (e.g. two
    // ingredient lines named "Salt" with different amounts).
    const aligned = ingredients.map((orig, i) => {
      const candidate = parsed.scaled[i];
      const amount =
        candidate &&
        typeof candidate.amount === "string" &&
        candidate.amount.trim()
          ? candidate.amount.trim().slice(0, 60)
          : orig.amount;
      return { name: orig.name, amount };
    });
    return res.json({ scaled: aligned });
  } catch (err) {
    logger.error({ err }, "Anthropic scaling failed");
    return res.json({ scaled: linearFallback(ingredients, fromServings, toServings) });
  }
});

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function linearFallback(
  items: ScaleIngredient[],
  from: number,
  to: number,
): ScaleIngredient[] {
  const factor = to / from;
  return items.map((i) => {
    const m = i.amount.match(/^([\d.]+)\s*(.*)$/);
    if (!m) return i;
    const num = parseFloat(m[1]);
    if (!Number.isFinite(num)) return i;
    const scaled = num * factor;
    const rounded = Math.round(scaled * 4) / 4;
    return { name: i.name, amount: `${formatNum(rounded)} ${m[2]}`.trim() };
  });
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

export default router;
