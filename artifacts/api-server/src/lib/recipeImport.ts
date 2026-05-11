// WS6 6c-1 — recipe import helpers: fetch a recipe URL, extract JSON-LD,
// normalize ingredient lines, and reformat into Kiwi's canonical shape via AI.
//
// PRD §10.9 — Reformat-for-Kiwi pass. Two-path flow:
//   1. URL → fetchRecipePage → extractJsonLdRecipe → structuredHints → AI
//   2. URL → fetchRecipePage → (no JSON-LD) → raw text → AI
// Either path lands in reformatRecipeForKiwi(). Failures return AICallFailure
// or null — the route maps both into a uniform URLImportFailure envelope.

import * as cheerio from "cheerio";
import { parse as parseIngredient } from "recipe-ingredient-parser-v3";
import Anthropic from "@anthropic-ai/sdk";

import { runAICall } from "./ai/runAICall";
import type { AICallResult } from "./ai/runAICall";
import type { PrismaLike } from "./ai/promptRegistry";
import {
  RawRecipeInputSchema,
  CanonicalRecipeSchema,
  type RawRecipeInput,
  type CanonicalRecipe,
} from "./ai/schemas/reformat";

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
      | "fetch_failed",
  ) {
    super(message);
    this.name = "RecipeImportError";
  }
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
      redirect: "follow",
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
  return runAICall(
    "import.reformat_for_kiwi",
    { rawRecipe },
    CanonicalRecipeSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );
}
