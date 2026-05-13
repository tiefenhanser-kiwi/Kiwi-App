-- WS6 6c-2 — Add `recipe_imported_image` to ActivityEventType.
-- Mirrors the 6c-1 pattern (single ALTER TYPE ... ADD VALUE). Emitted by the
-- new POST /api/recipes/import-image route on successful image-based recipe
-- imports, with metadata { imageCount, source: 'image' }.

ALTER TYPE "ActivityEventType" ADD VALUE 'recipe_imported_image';
