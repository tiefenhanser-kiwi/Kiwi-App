// Row 5 · Block 1 (D-WS9-149 + D-WS9-246) — the bucket writer. Takes image
// bytes from any source (publisher page, stock provider, generator), resizes
// to ~800 px on the long edge, re-encodes as JPEG, hands the bytes to the
// injected ObjectWriter, and returns the PUBLIC URL the client will render.
//
// Object keys: `meals/<mealId>.jpg` (and `templates/<templateId>.jpg` for the
// six seed rows). One rendition per meal (D-WS9-246: a single ~800 px asset
// covers the 16:10 hero and every thumb).
//
// The writer is injected — production is a GCS bucket authenticated by ADC
// (live.ts); the tests hand in an in-memory map. jimp is already a dependency
// (recipeImport.ts's vision resize).

import { Jimp } from "jimp";

import type { ObjectWriter } from "./types";

export const IMAGE_LONG_EDGE_PX = 800;
export const IMAGE_JPEG_QUALITY = 82;
export const DEFAULT_IMAGE_BUCKET = "kiwi-prod-508416-images";

export function publicUrlFor(bucket: string, key: string): string {
  return `https://storage.googleapis.com/${bucket}/${key}`;
}

export function mealImageKey(mealId: string): string {
  return `meals/${mealId}.jpg`;
}

export function templateImageKey(templateId: string): string {
  return `templates/${templateId}.jpg`;
}

export interface ResizedImage {
  bytes: Buffer;
  width: number;
  height: number;
  contentType: "image/jpeg";
}

// Decode → fit inside IMAGE_LONG_EDGE_PX (never upscale) → JPEG. Throws on an
// undecodable input (jimp 1.6 has no webp decoder) — the caller decides
// whether that candidate is skipped.
export async function resizeForStore(input: Buffer): Promise<ResizedImage> {
  const image = await Jimp.read(input);
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const longEdge = Math.max(w, h);
  if (longEdge > IMAGE_LONG_EDGE_PX) {
    if (w >= h) image.resize({ w: IMAGE_LONG_EDGE_PX });
    else image.resize({ h: IMAGE_LONG_EDGE_PX });
  }
  const bytes = await image.getBuffer("image/jpeg", { quality: IMAGE_JPEG_QUALITY });
  return { bytes, width: image.bitmap.width, height: image.bitmap.height, contentType: "image/jpeg" };
}

// Pure measurement for the "reject under 400 px" rule on bytes the publisher
// did not size: the decoded dimensions, or null when jimp cannot decode.
export async function measureImage(input: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const image = await Jimp.read(input);
    return { width: image.bitmap.width, height: image.bitmap.height };
  } catch {
    return null;
  }
}

export interface ImageStoreDeps {
  writer: ObjectWriter;
  bucket?: string;
}

export class ImageStore {
  private readonly bucket: string;
  constructor(private readonly deps: ImageStoreDeps) {
    this.bucket = deps.bucket ?? DEFAULT_IMAGE_BUCKET;
  }

  // Resize + upload; returns the public URL and the stored dimensions.
  async put(key: string, input: Buffer): Promise<{ url: string; width: number; height: number; bytes: number }> {
    const resized = await resizeForStore(input);
    await this.deps.writer.save(key, resized.bytes, resized.contentType);
    return {
      url: publicUrlFor(this.bucket, key),
      width: resized.width,
      height: resized.height,
      bytes: resized.bytes.byteLength,
    };
  }

  urlFor(key: string): string {
    return publicUrlFor(this.bucket, key);
  }
}
