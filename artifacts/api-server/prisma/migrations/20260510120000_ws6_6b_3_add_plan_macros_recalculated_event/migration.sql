-- WS6 6b-3 — Add `plan_macros_recalculated` to ActivityEventType.
-- Funnel event for the plan macro recalc endpoint
-- (POST /api/plans/:id/recalc-macros). Emitted once per recalc, not per
-- dish (per-dish AI estimations still emit dish_macros_estimated).
-- Mirrors the meal_found_similar_used / dish_macros_estimated extensions
-- from 6b-1 / 6b-2.

ALTER TYPE "ActivityEventType" ADD VALUE 'plan_macros_recalculated';
