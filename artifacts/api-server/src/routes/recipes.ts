import express, { Router, type IRouter } from "express";
import * as cheerio from "cheerio";
import { z } from "zod";

import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/auth";
import { runAICall } from "../lib/ai/runAICall";
import { ScaleResponseSchema } from "../lib/ai/schemas/scale";
import {
  CanonicalRecipeContentSchema,
  type CanonicalRecipeContent,
  IMAGE_IMPORT_FAILURE_MESSAGE,
  ImageInputSchema,
  TEXT_IMPORT_FAILURE_MESSAGE,
  URL_IMPORT_FAILURE_MESSAGE,
} from "../lib/ai/schemas/reformat";
import {
  fetchRecipePage,
  extractJsonLdRecipe,
  parseIngredientLines,
  reformatRecipeForKiwi,
  RecipeImportError,
  type RecipeJsonLd,
} from "../lib/recipeImport";

const router: IRouter = Router();

interface ScaleIngredient {
  name: string;
  amount: string;
}

interface ScaleRequestBody {
  recipeTitle?: string;
  fromServings?: number;
  toServings?: number;
  ingredients?: ScaleIngredient[];
}

const limiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 });
const importLimiter = rateLimit({ capacity: 12, refillPerSec: 12 / 60 });

router.post("/recipes/scale", requireAuth, limiter, async (req, res) => {
  const body = (req.body ?? {}) as ScaleRequestBody;
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

  const aiResult = await runAICall(
    "recipes.scale_ingredients",
    {
      scaleInput: {
        recipeTitle: body.recipeTitle?.slice(0, 100) ?? "",
        fromServings,
        toServings,
        ingredients,
      },
    },
    ScaleResponseSchema,
    { prisma, userId: req.userId ?? undefined },
  );

  if (!aiResult.success) {
    if (aiResult.reason !== "no_api_key") {
      logger.warn(
        { reason: aiResult.reason, err: aiResult.internalError },
        "Scaling AI call failed — falling back to linear scaling",
      );
    }
    return res.json({ scaled: linearFallback(ingredients, fromServings, toServings) });
  }

  // Align positionally — keying by name collapses duplicates (e.g. two
  // ingredient lines named "Salt" with different amounts).
  const aligned = ingredients.map((orig, i) => {
    const candidate = aiResult.data.scaled[i];
    const amount =
      candidate &&
      typeof candidate.amount === "string" &&
      candidate.amount.trim()
        ? candidate.amount.trim().slice(0, 60)
        : orig.amount;
    return { name: orig.name, amount };
  });
  return res.json({ scaled: aligned });
});

// ─────────────────────────────────────────────────────────────────
// POST /recipes/import-url — WS6 6c-1
// ─────────────────────────────────────────────────────────────────

const ImportUrlRequestSchema = z.object({
  url: z.string().min(1).max(2_000),
});

const MAX_RAW_TEXT_CHARS = 32_000;

router.post("/recipes/import-url", requireAuth, importLimiter, async (req, res) => {
  const parsed = ImportUrlRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      reason: "url_parse_failed",
      userFacingMessage: "That doesn't look like a valid URL.",
      suggestedAction: "try_image_import",
    });
  }
  const { url } = parsed.data;
  const userId = req.userId ?? null;

  let html: string;
  try {
    const fetched = await fetchRecipePage(url);
    html = fetched.html;
  } catch (err) {
    const code =
      err instanceof RecipeImportError ? err.code : "fetch_failed";
    logger.warn({ url, err, code }, "import-url fetch failed");
    // 6c-1-fix-2 added cloudflare_challenge + redirected — both ride the
    // generic fetch_error branch below, no special-casing required.
    return res.json({
      success: false,
      reason: code === "invalid_url" || code === "blocked_host"
        ? "url_parse_failed"
        : "fetch_error",
      userFacingMessage: URL_IMPORT_FAILURE_MESSAGE,
      suggestedAction: "try_image_import",
      internalError: err instanceof Error ? err.message : String(err),
    });
  }

  const jsonLd = extractJsonLdRecipe(html);
  const structuredHints = jsonLd ? buildStructuredHints(jsonLd) : undefined;
  const rawText = jsonLd ? undefined : htmlToText(html);
  const source: "structured_data" | "ai_fallback" = jsonLd ? "structured_data" : "ai_fallback";

  const aiResult = await reformatRecipeForKiwi(
    {
      url,
      ...(structuredHints ? { structuredHints } : {}),
      ...(rawText ? { rawText } : {}),
    },
    { prisma, userId: userId ?? undefined },
  );

  if (!aiResult.success) {
    return res.json({
      success: false,
      reason: aiResult.reason === "no_api_key" ? "sdk_error" : "sdk_error",
      userFacingMessage: URL_IMPORT_FAILURE_MESSAGE,
      suggestedAction: "try_image_import",
      internalError: aiResult.internalError,
    });
  }

  if (aiResult.data.status === "no_recipe_content") {
    return res.json({
      success: false,
      reason: "url_parse_failed",
      userFacingMessage: URL_IMPORT_FAILURE_MESSAGE,
      suggestedAction: "try_image_import",
      internalError: aiResult.data.reason,
    });
  }

  // Validate the recipe content once more to surface any drift before persistence.
  // (The discriminated-union parse already covered this — the explicit re-parse
  // here is a no-op safety net while the schema is new.)
  const recipe: CanonicalRecipeContent = CanonicalRecipeContentSchema.parse(
    aiResult.data.recipe,
  );

  if (userId) {
    prisma.userActivity
      .create({
        data: {
          userId,
          eventType: "recipe_imported_url",
          entityId: null,
          platform: "api",
          metadata: { source, sourceUrl: url },
        },
      })
      .catch((err) => {
        logger.warn({ err, url }, "recipe_imported_url activity write failed");
      });
  }

  return res.json({
    success: true,
    recipe,
    source,
    sourceUrl: url,
    caveats: aiResult.data.caveats ?? [],
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /recipes/import-image — WS6 6c-2
// ─────────────────────────────────────────────────────────────────

const ImportImageRequestSchema = z.object({
  images: z.array(ImageInputSchema).min(1).max(5),
});

// 35 MiB JSON ceiling: 5 images × 5 MiB raw × ~1.37 base64 overhead = ~34.3 MiB
// of base64 plus JSON wrapper. Per-image and total decoded-byte caps below
// enforce the real product limit (5 MiB / 25 MiB) after parsing.
const imageBodyParser = express.json({ limit: "35mb" });
const PER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TOTAL_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

// base64 length → decoded byte length, accounting for trailing '=' padding.
function base64DecodedByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

router.post(
  "/recipes/import-image",
  imageBodyParser,
  requireAuth,
  importLimiter,
  async (req, res) => {
    const parsed = ImportImageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        reason: "url_parse_failed",
        userFacingMessage: IMAGE_IMPORT_FAILURE_MESSAGE,
        suggestedAction: "try_text_import",
      });
    }

    const { images } = parsed.data;
    let totalBytes = 0;
    for (let i = 0; i < images.length; i++) {
      const bytes = base64DecodedByteLength(images[i].data);
      if (bytes > PER_IMAGE_MAX_BYTES) {
        return res.status(400).json({
          success: false,
          reason: "url_parse_failed",
          userFacingMessage:
            "One of those images is too large (max 5 MB each). Try a smaller or compressed photo.",
          suggestedAction: "try_text_import",
        });
      }
      totalBytes += bytes;
    }
    if (totalBytes > TOTAL_IMAGE_MAX_BYTES) {
      return res.status(400).json({
        success: false,
        reason: "url_parse_failed",
        userFacingMessage:
          "Those images add up to more than 25 MB total. Try fewer or smaller photos.",
        suggestedAction: "try_text_import",
      });
    }

    const userId = req.userId ?? null;
    const aiResult = await reformatRecipeForKiwi(
      { images },
      { prisma, userId: userId ?? undefined },
    );

    if (!aiResult.success) {
      return res.json({
        success: false,
        reason: "sdk_error",
        userFacingMessage: IMAGE_IMPORT_FAILURE_MESSAGE,
        suggestedAction: "try_text_import",
        internalError: aiResult.internalError,
      });
    }

    if (aiResult.data.status === "no_recipe_content") {
      return res.json({
        success: false,
        reason: "url_parse_failed",
        userFacingMessage: IMAGE_IMPORT_FAILURE_MESSAGE,
        suggestedAction: "try_text_import",
        internalError: aiResult.data.reason,
      });
    }

    const recipe: CanonicalRecipeContent = CanonicalRecipeContentSchema.parse(
      aiResult.data.recipe,
    );

    if (userId) {
      prisma.userActivity
        .create({
          data: {
            userId,
            eventType: "recipe_imported_image",
            entityId: null,
            platform: "api",
            metadata: { imageCount: images.length, source: "image" },
          },
        })
        .catch((err) => {
          logger.warn(
            { err, imageCount: images.length },
            "recipe_imported_image activity write failed",
          );
        });
    }

    return res.json({
      success: true,
      recipe,
      source: "image" as const,
      sourceUrl: null,
      caveats: aiResult.data.caveats ?? [],
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// POST /recipes/import-text — WS6 6c-3
// ─────────────────────────────────────────────────────────────────

const ImportTextRequestSchema = z.object({
  rawText: z
    .string()
    .min(50, "Recipe text too short — paste at least 50 characters")
    .max(40_000, "Recipe text too long — maximum 40,000 characters"),
});

// 40K chars fits comfortably under the default global JSON parser limit,
// so we deliberately do NOT add this path to ROUTE_SCOPED_JSON_PATHS.
router.post(
  "/recipes/import-text",
  requireAuth,
  importLimiter,
  async (req, res) => {
    const parsed = ImportTextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        reason: "url_parse_failed",
        userFacingMessage: TEXT_IMPORT_FAILURE_MESSAGE,
        suggestedAction: "try_image_import",
      });
    }

    const { rawText } = parsed.data;
    const userId = req.userId ?? null;

    const aiResult = await reformatRecipeForKiwi(
      { rawText },
      { prisma, userId: userId ?? undefined },
    );

    if (!aiResult.success) {
      return res.json({
        success: false,
        reason: "sdk_error",
        userFacingMessage: TEXT_IMPORT_FAILURE_MESSAGE,
        suggestedAction: "try_image_import",
        internalError: aiResult.internalError,
      });
    }

    if (aiResult.data.status === "no_recipe_content") {
      return res.json({
        success: false,
        reason: "url_parse_failed",
        userFacingMessage: TEXT_IMPORT_FAILURE_MESSAGE,
        suggestedAction: "try_image_import",
        internalError: aiResult.data.reason,
      });
    }

    const recipe: CanonicalRecipeContent = CanonicalRecipeContentSchema.parse(
      aiResult.data.recipe,
    );

    if (userId) {
      prisma.userActivity
        .create({
          data: {
            userId,
            eventType: "recipe_imported_text",
            entityId: null,
            platform: "api",
            metadata: { rawTextLength: rawText.length, source: "text" },
          },
        })
        .catch((err) => {
          logger.warn(
            { err, rawTextLength: rawText.length },
            "recipe_imported_text activity write failed",
          );
        });
    }

    return res.json({
      success: true,
      recipe,
      source: "text" as const,
      sourceUrl: null,
      caveats: aiResult.data.caveats ?? [],
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────

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

// Flatten JSON-LD instructions into a string[]. Schema.org permits a string,
// a HowToStep object, or a list of either; we walk them all.
function flattenInstructions(input: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      // HowToSection → walk itemListElement
      if (obj.itemListElement) {
        walk(obj.itemListElement);
        return;
      }
      // HowToStep → use text or name
      if (typeof obj.text === "string") {
        const t = obj.text.trim();
        if (t) out.push(t);
        return;
      }
      if (typeof obj.name === "string") {
        const n = obj.name.trim();
        if (n) out.push(n);
      }
    }
  };
  walk(input);
  return out;
}

function buildStructuredHints(jsonLd: RecipeJsonLd) {
  const rawIngredients = Array.isArray(jsonLd.recipeIngredient)
    ? jsonLd.recipeIngredient.filter((s): s is string => typeof s === "string")
    : [];
  const parsed = parseIngredientLines(rawIngredients);
  const steps = flattenInstructions(jsonLd.recipeInstructions);
  let servingsDefault: number | undefined;
  if (typeof jsonLd.recipeYield === "number" && jsonLd.recipeYield > 0) {
    servingsDefault = Math.trunc(jsonLd.recipeYield);
  } else if (typeof jsonLd.recipeYield === "string") {
    const m = jsonLd.recipeYield.match(/\d+/);
    if (m) servingsDefault = Number.parseInt(m[0], 10);
  }
  return {
    title: typeof jsonLd.name === "string" ? jsonLd.name : undefined,
    description:
      typeof jsonLd.description === "string" ? jsonLd.description : undefined,
    ingredients: parsed.length > 0 ? parsed : undefined,
    steps: steps.length > 0 ? steps : undefined,
    servingsDefault,
  };
}

// Strip HTML to plain text for the no-JSON-LD path. cheerio handles malformed
// markup more reliably than regex; we drop scripts/styles and collapse
// whitespace, then truncate to MAX_RAW_TEXT_CHARS so we never blow the AI
// context budget.
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, header, footer, nav, form").remove();
  const text = $("body").text() || $.text();
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_RAW_TEXT_CHARS
    ? collapsed.slice(0, MAX_RAW_TEXT_CHARS)
    : collapsed;
}

export default router;
