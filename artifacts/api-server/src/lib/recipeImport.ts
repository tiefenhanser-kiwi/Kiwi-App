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

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

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

// Time to response headers. Unchanged from 6c-1.
const FETCH_TIMEOUT_MS = 5_000;
// SEC-2 #2 — the WHOLE fetch, body included. The header timeout above used to
// be the only clock: once headers arrived, a server dripping one byte every two
// seconds held the request (and its socket) open for as long as it liked —
// SEC-1's probe gave up at 30 s and the connection was still open behind it.
const FETCH_DEADLINE_MS = 15_000;
// Applied to DECODED bytes as they arrive (see readCappedBody).
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

// ── SEC-2 #2 — WHERE THE FETCH IS ALLOWED TO GO ─────────────────────────
//
// The old guard was a list of regexes over the URL's HOSTNAME STRING. SEC-1
// walked straight past it: `[::1]` and `[0:0:0:0:0:0:0:1]` reached this
// server's own /api/healthz, IPv4-mapped IPv6 (`[::ffff:7f00:1]`,
// `[::ffff:a9fe:a9fe]` = the metadata server) and CGNAT were never listed, a
// hostname that RESOLVES to a private address was never resolved at all, and a
// closed port answered differently from an open one (a port scanner).
//
// The rule now is about ADDRESSES, checked where the socket is made:
//   · an IP-literal host is checked as written (Node never resolves one);
//   · any other host is resolved by `guardedLookup`, EVERY answer is checked,
//     and the socket connects to the address that was checked. There is no
//     second resolution for a rebinding DNS server to answer differently.
//   · ports 80 and 443 only.

/** Hostnames refused by NAME, before any resolution. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".internal", ".local"];
const ALLOWED_PORTS = new Set([80, 443]);

// [network, prefix length]. Loopback, "this network", RFC 1918, link-local
// (169.254/16 — the cloud metadata address), CGNAT (100.64/10), the IETF and
// documentation blocks, benchmarking, the 6to4 relay, multicast and reserved
// (224/4 and 240/4, which also covers 255.255.255.255).
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([net, bits]) => {
    const size = 2 ** (32 - bits);
    return Math.floor(n / size) === Math.floor(v4ToInt(net) / size);
  });
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function v6Groups(ip: string): number[] | null {
  let text = ip.split("%")[0]!.toLowerCase(); // a zone id says nothing about the address
  // A trailing dotted quad (`::ffff:127.0.0.1`) is two groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2]!)) return null;
    const n = v4ToInt(dotted[2]!);
    text = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * IPv6 is ALLOWLISTED to global unicast (2000::/3) and then trimmed. Outside
 * 2000::/3 sits everything this guard exists to refuse: unspecified (::),
 * loopback (::1), IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96)
 * addresses, NAT64 (64:ff9b::/96), discard (100::/64), ULA (fc00::/7),
 * link-local (fe80::/10), site-local (fec0::/10) and multicast (ff00::/8).
 * Inside it, the blocks that embed or tunnel to an IPv4 address or are
 * documentation-only: 2001::/23 (Teredo and the IETF block), 2001:db8::/32,
 * 2002::/16 (6to4) and 3fff::/20.
 */
function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  if ((g[0]! & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  if (g[0] === 0x2002) return true;
  if (g[0] === 0x3fff && g[1]! < 0x1000) return true;
  return false;
}

/** True for any address a server-side fetch must never reach. Unparseable = blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return isBlockedV4(bare);
  if (net.isIPv6(bare)) return isBlockedV6(bare);
  return true;
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOSTNAMES.has(h) || BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

/** Test-only seams. The import route passes none of these. */
export interface FetchRecipePageOptions {
  /** Replaces dns.lookup (the rebinding test). */
  dnsLookup?: typeof dns.lookup;
  /**
   * Lets a test reach its own 127.0.0.1 listener on a random port. Loopback
   * and the port rule ONLY — every other check still runs. Never set in prod.
   */
  allowLoopbackForTests?: boolean;
  deadlineMs?: number;
  headersTimeoutMs?: number;
  maxBodyBytes?: number;
}

function addressAllowed(ip: string, opts: FetchRecipePageOptions): boolean {
  if (opts.allowLoopbackForTests && (ip === "127.0.0.1" || ip === "::1")) return true;
  return !isBlockedAddress(ip);
}

function assertSafeUrl(rawUrl: string, opts: FetchRecipePageOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // The URL itself is never put in the message: messages reach the log.
    throw new RecipeImportError("Invalid URL", "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RecipeImportError(
      `Only http/https URLs are allowed (got ${parsed.protocol})`,
      "invalid_url",
    );
  }
  if (parsed.username || parsed.password) {
    throw new RecipeImportError("Credentials in URL", "invalid_url");
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port) && !opts.allowLoopbackForTests) {
    throw new RecipeImportError(`Blocked port ${port}`, "blocked_host");
  }
  // WHATWG URL has already normalised `2130706433`, `0x7f.1` and `0177.0.0.1`
  // to `127.0.0.1`; an IPv6 literal keeps its brackets in `hostname`.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!addressAllowed(host, opts)) {
      throw new RecipeImportError("Blocked address", "blocked_host");
    }
  } else if (isBlockedHostname(host)) {
    throw new RecipeImportError("Blocked host", "blocked_host");
  }
  return parsed;
}

/**
 * The `lookup` the socket uses. EVERY address the name resolves to must pass —
 * a record set mixing a public and a private address is refused outright, not
 * filtered — and the socket then connects to exactly what was checked.
 */
function guardedLookup(opts: FetchRecipePageOptions): net.LookupFunction {
  const lookup = opts.dnsLookup ?? dns.lookup;
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = (Array.isArray(addresses) ? addresses : []) as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => !addressAllowed(a.address, opts))) {
        return callback(
          new RecipeImportError("Host resolves to a blocked address", "blocked_host") as NodeJS.ErrnoException,
          "",
          0,
        );
      }
      if ((options as dns.LookupOptions).all) {
        (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      } else {
        callback(null, list[0]!.address, list[0]!.family);
      }
    });
  };
}

function decoderFor(encoding: string): NodeJS.ReadWriteStream | null {
  switch (encoding) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      throw new RecipeImportError("Unsupported content-encoding", "fetch_content_type");
  }
}

export async function fetchRecipePage(
  url: string,
  opts: FetchRecipePageOptions = {},
): Promise<{ html: string }> {
  const parsed = assertSafeUrl(url, opts);
  const deadlineMs = opts.deadlineMs ?? FETCH_DEADLINE_MS;
  const headersTimeoutMs = opts.headersTimeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const requestImpl = parsed.protocol === "https:" ? https.request : http.request;

  const body = await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (err: Error | null, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      if (err) reject(err);
      else resolve(buf!);
    };

    const req = requestImpl({
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        "User-Agent": KIWI_BOT_USER_AGENT,
        Accept: "text/html, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
      },
      lookup: guardedLookup(opts),
      // A fresh socket per fetch: a pooled one could have been made to an
      // address this request's lookup never saw.
      agent: false,
    });
    cleanups.push(() => req.destroy());

    // The overall deadline. Destroying the request tears down the socket and
    // the response stream with it, so a dripping server is cut off here.
    const deadline = setTimeout(
      () => finish(new RecipeImportError(`Fetch exceeded ${deadlineMs}ms`, "fetch_timeout")),
      deadlineMs,
    );
    const headersTimer = setTimeout(
      () => finish(new RecipeImportError(`No response headers after ${headersTimeoutMs}ms`, "fetch_timeout")),
      headersTimeoutMs,
    );
    cleanups.push(() => clearTimeout(deadline), () => clearTimeout(headersTimer));

    req.on("error", (err) => {
      finish(
        err instanceof RecipeImportError
          ? err
          : new RecipeImportError(`Fetch failed: ${(err as NodeJS.ErrnoException).code ?? err.name}`, "fetch_failed"),
      );
    });

    req.on("response", (res) => {
      clearTimeout(headersTimer);
      const status = res.statusCode ?? 0;
      // No redirect is ever followed (paywall walls, login walls, dead-recipe
      // redirects — and, since SEC-2, a redirect into the private network).
      // The Location header is never read: it used to ride into the message.
      if (status >= 300 && status < 400) {
        return finish(new RecipeImportError(`Redirect ${status}`, "redirected"));
      }
      if (status < 200 || status >= 300) {
        return finish(new RecipeImportError(`Fetch returned HTTP ${status}`, "fetch_status"));
      }
      const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
      if (
        !contentType.includes("text/html") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("application/xhtml+xml")
      ) {
        return finish(
          new RecipeImportError(`Unsupported content-type: ${contentType || "unknown"}`, "fetch_content_type"),
        );
      }
      const declared = Number.parseInt(String(res.headers["content-length"] ?? ""), 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return finish(new RecipeImportError(`Body too large: ${declared} bytes declared`, "fetch_too_large"));
      }

      let decoder: NodeJS.ReadWriteStream | null;
      try {
        decoder = decoderFor(String(res.headers["content-encoding"] ?? "").trim().toLowerCase());
      } catch (err) {
        return finish(err as Error);
      }
      const stream: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
      if (decoder) {
        cleanups.push(() => (decoder as unknown as { destroy(): void }).destroy());
      }

      // The cap is on DECODED bytes, counted as they arrive. SEC-1's gzip bomb
      // was ~12 KB on the wire and 12 MB decoded; the old check read the
      // whole body into memory first and measured it afterwards.
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          finish(new RecipeImportError(`Body too large: over ${maxBytes} decoded bytes`, "fetch_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (err: Error) =>
        finish(new RecipeImportError(`Body read failed: ${err.name}`, "fetch_failed")),
      );
      stream.on("end", () => finish(null, Buffer.concat(chunks)));
    });

    req.end();
  });

  const html = new TextDecoder("utf-8", { fatal: false }).decode(body);
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
      // D-WS9-053 §2.2 — temp 0: importing/reformatting is faithful extraction
      // of the source recipe (quantities included), not creative generation.
      temperature: 0,
      ...(attachments ? { attachments } : {}),
    },
  );
}
