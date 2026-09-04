-- WS9 — scope the Prep the Week cache invalidation to plan COMPOSITION.
--
-- The gate was `lastGeneratedFromPlanRevisionId = MealPlanInstance.revisionId`.
-- `revisionId` bumps on any structural plan edit, including edits the prep
-- payload cannot see: `loadPrepWeekInput` reads no date field whatsoever, so a
-- date-range edit or a day assignment could not change the prep structure, yet
-- each one threw the cache away and cost a full regeneration (~73 s, ~$0.125).
--
-- `composition_fingerprint` is a sha256 over the loader's output plus the
-- narrating prompt version, so it changes exactly when the result would.
--
-- NULLABLE, NO BACKFILL. Existing rows keep a NULL fingerprint, which the route
-- treats as a cache miss: each plan regenerates once on next open and is then
-- self-healed. Backfilling would require re-running the loader for every plan
-- and would stamp a fingerprint onto prose that a DIFFERENT prompt version
-- wrote — a lie that would suppress a regeneration that is genuinely needed.
ALTER TABLE "prep_week_structures"
  ADD COLUMN "compositionFingerprint" TEXT;
