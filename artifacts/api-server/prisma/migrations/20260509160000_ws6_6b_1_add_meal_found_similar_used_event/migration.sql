-- WS6 6b-1 — Add `meal_found_similar_used` to ActivityEventType.
-- Funnel event for the Find Similar AI flow (PRD §8.4 + §8.7 + §5.10).
-- Mirrors the wizard_failure enum-extension pattern from 6a-3.5.

ALTER TYPE "ActivityEventType" ADD VALUE 'meal_found_similar_used';
