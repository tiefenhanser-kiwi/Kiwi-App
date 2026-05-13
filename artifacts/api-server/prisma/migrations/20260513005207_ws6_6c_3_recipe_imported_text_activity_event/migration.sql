-- WS6 6c-3 — Add `recipe_imported_text` to ActivityEventType.
-- Mirrors the 6c-1 / 6c-2 pattern (single ALTER TYPE ... ADD VALUE). Emitted by
-- the new POST /api/recipes/import-text route on successful pasted-text recipe
-- imports, with metadata { rawTextLength, source: 'text' }.

-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'recipe_imported_text';
