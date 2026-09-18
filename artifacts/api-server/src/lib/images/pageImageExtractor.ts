// Row 5 · Block 1 (D-WS9-246 step 1) — the publisher's own image for a
// URL-imported meal.
//
// Order: schema.org Recipe JSON-LD `image` → `og:image` → `twitter:image`.
// PUBLISHER-DECLARED TAGS ONLY. This module never enumerates <img> elements —
// that is where ad creatives live (Hans: "we don't want a thumbnail of an ad
// by accident"). networkGuard.test.ts pins the absence of an `img` selector.
//
// Rejects: a declared dimension under MIN_EDGE_PX (JSON-LD ImageObject
// width/height, og:image:width/height, twitter:image:width/height — most
// pages declare none, and an undeclared size is NOT a rejection; the
// downloader measures the real bytes later), and a filename that looks like a
// logo / sprite / icon / avatar / placeholder / banner / ad.
//
// §27.2 reuse: JSON-LD parsing is lib/recipeImport.ts's extractJsonLdRecipe
// (the same @graph walk the import route already runs on this HTML). The
// Recipe node it returns carries `image` at runtime; RecipeJsonLd now types
// it. og/twitter are two cheerio meta lookups.

import * as cheerio from "cheerio";

import { extractJsonLdRecipe } from "../recipeImport";

export const MIN_EDGE_PX = 400;

export type PageImageOrigin = "jsonld" | "og" | "twitter";

export interface PageImageCandidate {
  url: string;
  origin: PageImageOrigin;
  // Declared by the publisher; null when the page did not say.
  width: number | null;
  height: number | null;
}

export interface PageImageRejection {
  url: string;
  origin: PageImageOrigin;
  reason: "too_small" | "filename_shape" | "not_http";
}

export interface PageImageExtraction {
  accepted: PageImageCandidate | null;
  rejected: PageImageRejection[];
}

// Filename shapes that are never the dish. Matched against the URL PATH
// (every segment — an `/ads/` or `/icons/` directory is as telling as the
// filename), lowercased, with query and hash stripped. Word-ish boundaries so
// "logo" does not match "catalogo" but does match "site-logo.png" / "logo_2x".
const REJECT_FILENAME =
  /(^|[^a-z])(logo|sprite|icon|favicon|avatar|placeholder|banner|advert|ads?)([^a-z]|$)/;

function pathOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

export function hasRejectedFilenameShape(url: string): boolean {
  return REJECT_FILENAME.test(pathOf(url));
}

function toPositiveInt(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// JSON-LD `image` is any of: "url", ["url", ...], {ImageObject}, [{ImageObject}].
// ImageObject's url lives in `url` or `contentUrl`. First usable entry wins.
function jsonLdImageCandidates(image: unknown): PageImageCandidate[] {
  const list = Array.isArray(image) ? image : [image];
  const out: PageImageCandidate[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push({ url: entry, origin: "jsonld", width: null, height: null });
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const url = obj.url ?? obj.contentUrl;
      if (typeof url !== "string") continue;
      out.push({
        url,
        origin: "jsonld",
        width: toPositiveInt(obj.width),
        height: toPositiveInt(obj.height),
      });
    }
  }
  return out;
}

function metaContent($: cheerio.CheerioAPI, names: string[]): string | null {
  for (const n of names) {
    const el = $(`meta[property="${n}"], meta[name="${n}"]`).first();
    const c = el.attr("content")?.trim();
    if (c) return c;
  }
  return null;
}

function metaCandidate(
  $: cheerio.CheerioAPI,
  origin: "og" | "twitter",
): PageImageCandidate | null {
  const prefix = origin === "og" ? "og:image" : "twitter:image";
  // og:image:secure_url and twitter:image:src are the documented aliases.
  const url = metaContent(
    $,
    origin === "og"
      ? ["og:image:secure_url", "og:image"]
      : ["twitter:image", "twitter:image:src"],
  );
  if (!url) return null;
  return {
    url,
    origin,
    width: toPositiveInt(metaContent($, [`${prefix}:width`])),
    height: toPositiveInt(metaContent($, [`${prefix}:height`])),
  };
}

function judge(
  c: PageImageCandidate,
): { ok: true } | { ok: false; reason: PageImageRejection["reason"] } {
  if (!/^https?:\/\//i.test(c.url)) return { ok: false, reason: "not_http" };
  if (hasRejectedFilenameShape(c.url)) return { ok: false, reason: "filename_shape" };
  if ((c.width != null && c.width < MIN_EDGE_PX) || (c.height != null && c.height < MIN_EDGE_PX)) {
    return { ok: false, reason: "too_small" };
  }
  return { ok: true };
}

// Pure. Given the page's HTML, the first acceptable publisher-declared image,
// plus every candidate that was rejected and why (diagnostic for the pilot).
export function extractPageImage(html: string): PageImageExtraction {
  const rejected: PageImageRejection[] = [];
  const candidates: PageImageCandidate[] = [];

  const recipe = extractJsonLdRecipe(html);
  if (recipe?.image != null) candidates.push(...jsonLdImageCandidates(recipe.image));

  const $ = cheerio.load(html);
  const og = metaCandidate($, "og");
  if (og) candidates.push(og);
  const tw = metaCandidate($, "twitter");
  if (tw) candidates.push(tw);

  for (const c of candidates) {
    const verdict = judge(c);
    if (verdict.ok) return { accepted: c, rejected };
    rejected.push({ url: c.url, origin: c.origin, reason: verdict.reason });
  }
  return { accepted: null, rejected };
}
