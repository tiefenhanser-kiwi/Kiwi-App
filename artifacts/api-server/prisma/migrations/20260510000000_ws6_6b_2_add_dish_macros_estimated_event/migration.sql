-- WS6 6b-2 — Add `dish_macros_estimated` to ActivityEventType.
-- Funnel event for the AI macro estimator (PRD §11). Helper ships in 6b-2
-- as a server-only utility; WS7 wires the consumer (POST/PATCH /me/dishes)
-- and is the first place the event will actually be emitted.
-- Mirrors the meal_found_similar_used enum-extension pattern from 6b-1.

ALTER TYPE "ActivityEventType" ADD VALUE 'dish_macros_estimated';
