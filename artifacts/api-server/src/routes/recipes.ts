import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";

import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/auth";

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
const catalogLimiter = rateLimit({ capacity: 30, refillPerSec: 30 / 60 }); // 30 burst, ~1 every 2s

router.post("/recipes/scale", requireAuth, limiter, async (req, res) => {
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

router.get("/recipes", requireAuth, catalogLimiter, async (req, res) => {
  const limit = Math.min(
    100,
    Math.max(1, Number(req.query.limit) || 20),
  );
  const cursor =
    typeof req.query.cursor === "string" && req.query.cursor.length > 0
      ? req.query.cursor
      : undefined;

  try {
    const meals = await prisma.meal.findMany({
      where: { isArchived: false, isPublic: true },
      select: {
        id: true,
        title: true,
        cuisineType: true,
        estimatedTimeMinutes: true,
        servingsDefault: true,
        caloriesPerServing: true,
        proteinGPerServing: true,
        carbsGPerServing: true,
        fatGPerServing: true,
        tags: true,
        imageUrl: true,
      },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { title: "asc" },
    });

    const hasMore = meals.length > limit;
    const page = hasMore ? meals.slice(0, limit) : meals;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    return res.json({
      recipes: page.map(toListShape),
      nextCursor,
    });
  } catch (err) {
    logger.error({ err }, "Failed to list recipes");
    return res.status(500).json({ error: "failed to list recipes" });
  }
});

router.get("/recipes/:id", requireAuth, catalogLimiter, async (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    return res.status(400).json({ error: "invalid recipe id" });
  }

  try {
    const meal = await prisma.meal.findUnique({
      where: { id },
      include: {
        dishLinks: {
          orderBy: { positionIndex: "asc" },
          include: {
            dish: {
              include: {
                dishIngredients: {
                  orderBy: { positionIndex: "asc" },
                  include: { ingredient: true },
                },
              },
            },
          },
        },
      },
    });

    if (!meal || meal.isArchived) {
      return res.status(404).json({ error: "recipe not found" });
    }

    // Steps use the polymorphic ownerType/ownerId pattern (no Prisma relation
    // due to the FK fix in WS1-prep). Separate query.
    const steps = await prisma.recipeInstructionStep.findMany({
      where: { ownerType: "meal", ownerId: id },
      orderBy: { stepIndex: "asc" },
    });

    // Flatten the first dish's ingredients. The seed creates one dish per
    // meal, so this is 1:1. When meals gain multiple dishes post-WS6, this
    // shape will need rework — flag for that workstream.
    const firstDish = meal.dishLinks[0]?.dish;
    const ingredients =
      firstDish?.dishIngredients.map((di) => ({
        name: di.ingredient.displayName,
        amount: `${formatQuantity(di.quantity)} ${di.unit}`.trim(),
        category: di.ingredient.category,
      })) ?? [];

    return res.json({
      ...toListShape(meal),
      ingredients,
      steps: steps.map((s) => ({
        text: s.stepTextTranslated,
        stepIndex: s.stepIndex,
        estimatedMinutes: s.estimatedMinutes,
        phaseType: s.phaseType,
        parallelGroup: s.parallelGroup,
        requiresPreheat: s.requiresPreheat,
        requiresRest: s.requiresRest,
        requiresMarination: s.requiresMarination,
        isTimingSensitive: s.isTimingSensitive,
      })),
    });
  } catch (err) {
    logger.error({ err, id }, "Failed to fetch recipe detail");
    return res.status(500).json({ error: "failed to fetch recipe" });
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

// ── shape helpers for recipe catalog endpoints ────────────────────────────

// Reassembles a stored {quantity, unit} pair into a human-readable string
// matching the original mockData format. Handles common fractions; fallback
// is a decimal-trimmed number. Not lossless for edge cases like "2 (6 oz)"
// (stored quantity=2, unit="6 oz" → reassembles as "2 6 oz"), but good
// enough for WS1.
function formatQuantity(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (n === 0.5) return "1/2";
  if (n === 0.25) return "1/4";
  if (n === 0.75) return "3/4";
  if (Math.abs(n - 1 / 3) < 0.01) return "1/3";
  if (Math.abs(n - 2 / 3) < 0.01) return "2/3";
  return n.toFixed(2).replace(/\.?0+$/, "");
}

interface RecipeListItem {
  id: string;
  title: string;
  cuisine: string;
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  tags: string[];
  image: string | null;
}

function toListShape(m: {
  id: string;
  title: string;
  cuisineType: string | null;
  estimatedTimeMinutes: number;
  servingsDefault: number;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  tags: string[];
  imageUrl: string | null;
}): RecipeListItem {
  return {
    id: m.id,
    title: m.title,
    cuisine: m.cuisineType ?? "",
    minutes: m.estimatedTimeMinutes,
    servings: m.servingsDefault,
    calories: m.caloriesPerServing,
    protein: m.proteinGPerServing,
    carbs: m.carbsGPerServing,
    fat: m.fatGPerServing,
    tags: m.tags,
    image: m.imageUrl,
  };
}

export default router;
