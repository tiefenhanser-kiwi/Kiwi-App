// WS6 6c — recipe import helpers: fetch a recipe URL, extract JSON-LD,
// normalize ingredient lines, and reformat into Kiwi's canonical shape via AI.
//
// PRD §10.9 — Reformat-for-Kiwi pass. Three import paths funnel into the same
// reformatRecipeForKiwi() call, each gated by its own route:
//   1. URL (6c-1)   — fetchRecipePage → extractJsonLdRecipe → structuredHints, or raw HTML → text
//   2. Image (6c-2) — base64 photos → Anthropic Vision multi-block content
//   3. Text  (6c-3) — pasted recipe text → AI direct
// Failures return AICallFailure or null — each route maps them into a uniform
// URLImportFailure envelope (with a path-specific userFacingMessage).

import * as cheerio from "cheerio";
import { Jimp } from "jimp";
import { parse as parseIngredient } from "recipe-ingredient-parser-v3";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { logger } from "./logger";
import { runAICall } from "./ai/runAICall";
import type { AICallResult } from "./ai/runAICall";
import type { PrismaLike } from "./ai/promptRegistry";
import {
  RawRecipeInputSchema,
  CanonicalRecipeSchema,
  type ImageInput,
  type RawRecipeInput,
  type CanonicalRecipe,
} from "./ai/schemas/reformat";

// 6c-2-fix-2 — strip `null` values from the AI response before Zod validation.
// Cookbook-photo imports sometimes return `null` for unknown optional fields
// (sourceUrl, description). The schema's `.optional()` accepts missing keys
// and `undefined`, but rejects `null`. Rather than loosen the schema's
// semantic contract with `.nullable()`, we drop nulls here so they become
// "missing" — preserving the schema's intent. Applied via z.preprocess on the
// wrapper schema passed to runAICall; the underlying CanonicalRecipeSchema is
// unchanged. Recursive: handles nested objects, arrays-of-primitives, and
// arrays-of-objects (instruction steps, ingredients).
export function stripNullValues(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map(stripNullValues)
      .filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripNullValues(v);
      if (stripped !== undefined) result[k] = stripped;
    }
    return result;
  }
  return value;
}

const CanonicalRecipeSchemaWithStripping = z.preprocess(
  stripNullValues,
  CanonicalRecipeSchema,
);

// ─────────────────────────────────────────────────────────────────
// URL fetch
// ─────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Identifies KiwiBot to recipe sites + provides a contact URL per bot-operator
// convention. Earlier "Kiwi/1.0" was 403'd by AllRecipes anti-bot in 6c-1 smoke.
export const KIWI_BOT_USER_AGENT =
  "Mozilla/5.0 (compatible; KiwiBot/1.0; +https://kitchenwizard.ai/bot)";

export class RecipeImportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_url"
      | "blocked_host"
      | "fetch_timeout"
      | "fetch_status"
      | "fetch_content_type"
      | "fetch_too_large"
      | "fetch_failed"
      | "cloudflare_challenge"
      | "redirected",
  ) {
    super(message);
    this.name = "RecipeImportError";
  }
}

// Cloudflare challenge-page markers. Two-or-more matches indicate a managed
// challenge body, not a real recipe page. Anchored to bytes Cloudflare emits
// in their challenge HTML (`_cf_chl_opt`, the challenge-platform script path,
// the JS-required notice). Single matches alone may appear in legit content
// (a blog quoting Cloudflare), so we require ≥2 to flag.
const CLOUDFLARE_CHALLENGE_MARKERS = [
  "_cf_chl_opt",
  "challenge-platform",
  "cf-chl-bypass",
  "cf-browser-verification",
  "enable javascript and cookies to continue",
  "__cf_chl_tk",
] as const;

function detectsCloudflareChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  let hits = 0;
  for (const marker of CLOUDFLARE_CHALLENGE_MARKERS) {
    if (lower.includes(marker)) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
];

function assertSafeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RecipeImportError(`Invalid URL: ${rawUrl}`, "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RecipeImportError(
      `Only http/https URLs are allowed (got ${parsed.protocol})`,
      "invalid_url",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0") {
    throw new RecipeImportError(`Blocked host: ${host}`, "blocked_host");
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(host)) {
      throw new RecipeImportError(`Blocked private IP: ${host}`, "blocked_host");
    }
  }
  return parsed;
}

export async function fetchRecipePage(url: string): Promise<{ html: string }> {
  assertSafeUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": KIWI_BOT_USER_AGENT, Accept: "text/html, text/plain, */*" },
      signal: controller.signal,
      // Manual redirect so we can refuse 3xx (paywall walls, login walls,
      // dead-recipe redirects). Auto-follow lets the AI parse whatever the
      // redirect target happens to be — usually a different recipe.
      redirect: "manual",
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("abort")) {
      throw new RecipeImportError(`Fetch timeout after ${FETCH_TIMEOUT_MS}ms`, "fetch_timeout");
    }
    throw new RecipeImportError(`Fetch failed: ${msg}`, "fetch_failed");
  }
  clearTimeout(timer);

  // Manual-redirect mode: 3xx is NOT `!response.ok`, so check it first.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no Location header)";
    throw new RecipeImportError(
      `Redirect ${response.status} → ${location}`,
      "redirected",
    );
  }
  if (!response.ok) {
    throw new RecipeImportError(
      `Fetch returned HTTP ${response.status}`,
      "fetch_status",
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    throw new RecipeImportError(
      `Unsupported content-type: ${contentType || "unknown"}`,
      "fetch_content_type",
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new RecipeImportError(
        `Body too large: ${declared} bytes`,
        "fetch_too_large",
      );
    }
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new RecipeImportError(
      `Body too large: ${buffer.byteLength} bytes`,
      "fetch_too_large",
    );
  }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (detectsCloudflareChallenge(html)) {
    throw new RecipeImportError(
      "Cloudflare challenge page detected — site requires JS/cookies",
      "cloudflare_challenge",
    );
  }
  return { html };
}

// ─────────────────────────────────────────────────────────────────
// JSON-LD extraction
// ─────────────────────────────────────────────────────────────────

export interface RecipeJsonLd {
  name?: string;
  description?: string;
  recipeIngredient?: string[];
  recipeInstructions?: unknown;
  recipeYield?: string | number;
  totalTime?: string;
  cookTime?: string;
  prepTime?: string;
  recipeCuisine?: string | string[];
  recipeCategory?: string | string[];
  author?: unknown;
  url?: string;
}

function isRecipeNode(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object") return false;
  const t = (node as Record<string, unknown>)["@type"];
  if (typeof t === "string") return t === "Recipe" || t.endsWith("/Recipe");
  if (Array.isArray(t)) return t.some((v) => typeof v === "string" && (v === "Recipe" || v.endsWith("/Recipe")));
  return false;
}

function walkJsonLdForRecipe(node: unknown): Record<string, unknown> | null {
  if (isRecipeNode(node)) return node as Record<string, unknown>;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkJsonLdForRecipe(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const graph = (node as Record<string, unknown>)["@graph"];
    if (graph) return walkJsonLdForRecipe(graph);
  }
  return null;
}

export function extractJsonLdRecipe(html: string): RecipeJsonLd | null {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const raw = $(script).contents().text().trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const found = walkJsonLdForRecipe(parsed);
    if (found) {
      return found as RecipeJsonLd;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Ingredient normalization
// ─────────────────────────────────────────────────────────────────

const TO_TASTE_PATTERNS = [/^to taste$/i, /^as needed$/i, /^to your liking$/i];

export function normalizeIngredientQuantity(
  raw: string,
  unit: string,
): { quantity: number; unit: string } {
  const trimmed = (raw ?? "").toString().trim();
  if (!trimmed || TO_TASTE_PATTERNS.some((p) => p.test(trimmed))) {
    return { quantity: 1, unit: "to_taste" };
  }
  // Mixed fraction like "1 1/2"
  const mixed = trimmed.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den !== 0) return { quantity: whole + num / den, unit };
  }
  // Pure fraction "1/2"
  const frac = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (den !== 0) return { quantity: num / den, unit };
  }
  // Decimal "0.5" or integer "2"
  const num = Number(trimmed);
  if (Number.isFinite(num) && num > 0) {
    return { quantity: num, unit };
  }
  // Fall through: unparseable but non-empty → flag with quantity=1 for AI repair downstream.
  return { quantity: 1, unit: unit || "unknown" };
}

export interface ParsedIngredientLine {
  name: string;
  quantity: number;
  unit: string;
  preparationNote?: string;
}

interface ParsedIngredientRaw {
  quantity: number;
  unit: string | null;
  ingredient: string;
}

export function parseIngredientLines(rawLines: string[]): ParsedIngredientLine[] {
  const results: ParsedIngredientLine[] = [];
  for (const line of rawLines) {
    if (!line || !line.trim()) continue;
    let parsed: ParsedIngredientRaw | null = null;
    try {
      parsed = parseIngredient(line, "eng") as ParsedIngredientRaw;
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.ingredient) {
      results.push({
        name: line.trim(),
        quantity: 1,
        unit: "unknown",
        preparationNote: line.trim(),
      });
      continue;
    }
    // The parser returns quantity as a number directly; normalize only the
    // "to taste" / empty paths (numeric 0/NaN guard) and keep the unit as-is.
    let quantity = Number.isFinite(parsed.quantity) && parsed.quantity > 0
      ? parsed.quantity
      : 1;
    let unit = parsed.unit ?? "";
    if (!unit) {
      // No unit + low quantity → likely a bare-count line ("4 eggs") OR a
      // "to taste" line. Mark as "each" for counts, "to_taste" for words.
      const looksLikeCount =
        Number.isFinite(parsed.quantity) && parsed.quantity > 0;
      unit = looksLikeCount ? "each" : "to_taste";
      if (!looksLikeCount) quantity = 1;
    }
    results.push({
      name: parsed.ingredient.trim(),
      quantity,
      unit,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────
// Server-side image resize (D-WS6-083) — defense-in-depth chokepoint
// ─────────────────────────────────────────────────────────────────
// Mobile already resizes via expo-image-manipulator (kiwi/lib/api/recipeImport.ts).
// This server-side pass catches the smoke harness, future non-mobile callers,
// and any path that bypasses the route layer. Anthropic Vision recommends
// ≤1568px on the long edge; payloads above ~1 MB on the wire trigger SDK
// transport failures (Block 2 APIConnectionError). JPEG q=70 lands typical
// recipe-card photos around 150–300 KB raw.

const RESIZE_LONG_EDGE_PX = 1568;
const RESIZE_BYTES_THRESHOLD = 500 * 1024;
const RESIZE_JPEG_QUALITY = 70;

async function resizeImageForVision(img: ImageInput): Promise<ImageInput> {
  const originalBuffer = Buffer.from(img.data, "base64");
  const originalBytes = originalBuffer.byteLength;

  let image: Awaited<ReturnType<typeof Jimp.read>>;
  try {
    image = await Jimp.read(originalBuffer);
  } catch (err) {
    // jimp 1.6 supports jpeg/png/gif/bmp/tiff but NOT webp. If decode fails,
    // pass through unmodified — the Anthropic SDK can still accept the
    // original payload (it just doesn't benefit from resize).
    logger.warn(
      {
        event: "image_resize",
        didResize: false,
        skipped: "decode_failed",
        originalMediaType: img.mediaType,
        originalBytes,
        err: err instanceof Error ? err.message : String(err),
      },
      "image_resize decode failed — passing through",
    );
    return img;
  }

  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;
  const longEdge = Math.max(originalWidth, originalHeight);
  const needsResize =
    longEdge > RESIZE_LONG_EDGE_PX || originalBytes > RESIZE_BYTES_THRESHOLD;

  if (!needsResize) {
    return img;
  }

  if (originalWidth >= originalHeight) {
    image.resize({ w: Math.min(RESIZE_LONG_EDGE_PX, originalWidth) });
  } else {
    image.resize({ h: Math.min(RESIZE_LONG_EDGE_PX, originalHeight) });
  }

  const outBuffer = await image.getBuffer("image/jpeg", {
    quality: RESIZE_JPEG_QUALITY,
  });

  return {
    mediaType: "image/jpeg",
    data: outBuffer.toString("base64"),
  };
}

// ─────────────────────────────────────────────────────────────────
// AI reformat
// ─────────────────────────────────────────────────────────────────

export interface ReformatRecipeOptions {
  prisma?: PrismaLike;
  userId?: string;
  client?: Pick<Anthropic, "messages">;
}

export async function reformatRecipeForKiwi(
  rawRecipe: RawRecipeInput,
  opts: ReformatRecipeOptions = {},
): Promise<AICallResult<CanonicalRecipe>> {
  // Validate input shape early so the AI call doesn't waste tokens on garbage.
  RawRecipeInputSchema.parse(rawRecipe);

  // 6c-2 — vision path. When images are present, pass them as Anthropic
  // ImageBlockParam attachments. Strip the base64 from the var substitution:
  // renderPromptBody JSON.stringify's the rawRecipe into {{rawRecipe}}, and
  // we don't want 25MB of base64 echoed inline (model sees the images via
  // the attachment blocks instead).
  const rawImages = rawRecipe.images ?? [];
  // D-WS6-083 — resize before building Anthropic ImageBlockParams.
  const images =
    rawImages.length > 0
      ? await Promise.all(rawImages.map(resizeImageForVision))
      : rawImages;
  const attachments: Anthropic.ImageBlockParam[] | undefined =
    images.length > 0
      ? images.map((img) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.data,
          },
        }))
      : undefined;
  const { images: _strippedImages, ...rawRecipeForPrompt } = rawRecipe;
  const varsRawRecipe =
    images.length > 0
      ? { ...rawRecipeForPrompt, imagesAttached: images.length }
      : rawRecipe;

  return runAICall(
    "import.reformat_for_kiwi",
    { rawRecipe: varsRawRecipe },
    CanonicalRecipeSchemaWithStripping,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
      ...(attachments ? { attachments } : {}),
    },
  );
}
