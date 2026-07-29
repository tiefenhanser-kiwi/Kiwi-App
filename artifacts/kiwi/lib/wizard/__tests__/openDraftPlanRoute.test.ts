// WS9 Block 3c (D-WS9-032) — tests for buildOpenDraftParams. Pins the contract
// that opens Plan Review as an unsaved draft: a placeholder path id, the draft
// id threaded through, and the expanded plan carried as JSON (so the draft
// adapter can render it). Pure function, no React.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WizardExpandResponse } from "@/lib/api/wizard";

import {
  buildOpenDraftParams,
  DRAFT_PLAN_ROUTE_ID,
} from "../openDraftPlanRoute";

// Fixture: a minimal expand response — a draft id + a one-meal expanded plan.
// Carries the exact fields buildOpenDraftParams reads (draft.id, expanded).
const EXPAND: WizardExpandResponse = {
  draft: { id: "draft-xyz", createdAt: "2026-07-28T00:00:00.000Z" },
  expanded: {
    candidateId: "cand-1",
    title: "Cozy Comfort Week",
    tags: ["Comfort"],
    whyBullets: ["one-pot meals"],
    meals: [
      {
        title: "Chili",
        cuisineType: "American",
        estimatedTimeMinutes: 40,
        difficulty: "easy",
        servings: 4,
        dishes: [],
      },
    ],
  },
} as WizardExpandResponse;

test("buildOpenDraftParams: id is the placeholder segment (draft mode never fetches it)", () => {
  const params = buildOpenDraftParams(EXPAND);
  assert.equal(params.id, DRAFT_PLAN_ROUTE_ID);
  assert.equal(params.id, "draft");
});

test("buildOpenDraftParams: threads the draft id through", () => {
  const params = buildOpenDraftParams(EXPAND);
  assert.equal(params.draftId, "draft-xyz");
});

test("buildOpenDraftParams: carries the expanded plan as JSON the adapter can parse back", () => {
  const params = buildOpenDraftParams(EXPAND);
  const roundTrip = JSON.parse(params.expanded);
  assert.equal(roundTrip.title, "Cozy Comfort Week");
  assert.equal(roundTrip.meals.length, 1);
  assert.equal(roundTrip.meals[0].title, "Chili");
});
