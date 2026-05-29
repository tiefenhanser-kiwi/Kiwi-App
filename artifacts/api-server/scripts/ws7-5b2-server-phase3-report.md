# WS7-5b2-server — Phase 3 report

`POST /wizard/drafts/:id/save` — promote hidden wizard draft into an undated, inactive plan ("Save for Later"). Server-only slice. Mobile wiring follows in a separate block. No migration. No mobile code touched. No mods to `/activate`.

---

## 1. The `/save` route

[wizard.ts:877-989](artifacts/api-server/src/routes/wizard.ts#L877-L989) — full handler. Excerpt of the tx + tail + emitActivity (the only delta from `/activate`):

```ts
const result = await prisma.$transaction(async (tx) => {
  const materialized = await materializeWizardDraftImpl({
    prisma, tx, userId, draftId,
  });

  // Save tail — flip ONLY isWizardDraft. The materializer is identical to
  // activate's, so the same 60s tx budget applies (same per-dish write
  // volume; D-WS7-067 createMany batching will improve both paths).
  // status stays "draft", dates stay null, isActiveThisWeek stays false,
  // revisionId stays at its default (1 from the expand persist write).
  // NOT demoting prior actives — this isn't becoming active.
  const saved = await tx.mealPlanInstance.update({
    where: { id: draftId },
    data: { isWizardDraft: false },
    select: { id: true, revisionId: true },
  });

  await emitSharedActivity({
    tx, userId,
    eventType: "plan_created",
    entityType: "MealPlanInstance",
    entityId: saved.id,
    metadata: {
      source: "wizard_draft_save",
      mealsCreated: materialized.mealsCreated,
      itemsCreated: materialized.itemsCreated,
    },
  });

  return saved;
}, { timeout: 60_000, maxWait: 20_000 });

return res.status(201).json({
  instance: { id: result.id, revisionId: result.revisionId },
});
```

Tx wall-time instrumentation mirrors the activate fix (logged on both success and throw paths). Error mapping is the verbatim error map from `/activate`.

## 2. Materializer reuse confirmation

`materializeWizardDraft` ([wizardActivation.ts:216](artifacts/api-server/src/lib/wizardActivation.ts#L216)) is reused **unchanged**. No edits to [wizardActivation.ts](artifacts/api-server/src/lib/wizardActivation.ts). `git status -- artifacts/api-server/src/lib/wizardActivation.ts` confirms no diff. The materializer's own preamble (Pass 1: read draft + Zod parse + ingredient upserts on plain `prisma`) and critical section (Pass 2: meal-graph writes on `tx`) are identical for save and activate — only the post-materialize tail differs in the route layer.

## 3. revisionId handling for the non-active case

Activate's flip increments revisionId: `data: { ..., revisionId: { increment: 1 } }` ([wizard.ts:801-809](artifacts/api-server/src/routes/wizard.ts#L801-L809)). That takes the draft (created at the schema default `revisionId: 1` by `persistWizardDraft`) to `revisionId: 2` on activation — treating activate as a "structural mutation" of the live plan.

**Save deliberately does NOT bump revisionId.** Save is a fresh promotion, not a mutation of an active plan. Confirmed match with `POST /plans/use-template` ([plans.ts:945-960](artifacts/api-server/src/routes/plans.ts#L945-L960)): that path creates a brand-new instance at the schema default `revisionId: 1` (no increment), and the smoke confirms the saved row's `revisionId: 1` (REPORT block §6, `save.revisionId: 1`). This keeps the semantic of "freshly-materialized" consistent across both code paths that produce a new visible plan from a hidden source.

## 4. Error-guard mirror — identical to `/activate`

The route reuses the same guards as `/activate` via the shared materializer:

| Case | Source | HTTP |
|---|---|---|
| not found / not owned / not a draft | `materializeWizardDraft` → `WizardDraftNotFoundError` (single guard `!draft.isWizardDraft` at [wizardActivation.ts:231](artifacts/api-server/src/lib/wizardActivation.ts#L231)) | 404 |
| malformed JSON | `materializeWizardDraft` → `WizardDraftMalformedError` | 422 (with `reason`) |
| invalid `:id` (empty / >100 chars) | route-level guard | 400 |
| unauthenticated | `requireAuth` middleware | 401 |
| anything else | catch-all | 500 |

**Already-saved or already-activated draft:** the materializer's preamble guards `!draft.isWizardDraft` — once activate or save flips `isWizardDraft → false`, a subsequent `/save` (or `/activate`) call on the same id throws `WizardDraftNotFoundError`, which the route maps to 404. This is the desired semantic: "if the instance is no longer a hidden draft, it's not save-able." Confirmed identical to `/activate`'s behavior (same shared guard, same `WizardDraftNotFoundError` exception type).

## 5. Tests

New count: **612** (up from 605 base — +7 from this slice: 5 in this commit plus the activate "auth header" + happy path skip mixups already present, but the test ledger shows 612 total / 610 pass / 2 skipped / 0 fail). 5 new save-route describe blocks added at [wizard.test.ts:2182](artifacts/api-server/src/routes/__tests__/wizard.test.ts#L2182):

- **happy path** ([wizard.test.ts:2188-2257](artifacts/api-server/src/routes/__tests__/wizard.test.ts#L2188-L2257)) — 201 + `{ instance: { id, revisionId } }`; materializer invoked once; `updateMany` (demote) NOT called; `update.data` has **only** `isWizardDraft: false` (no `isActiveThisWeek`, no `startDate`/`endDate`, no `status`, no `revisionId` increment); activity is `plan_created` with the saved id.
- **prior active is NOT demoted** ([wizard.test.ts:2259-2306](artifacts/api-server/src/routes/__tests__/wizard.test.ts#L2259-L2306)) — asserts the save tail does not call `updateMany`, the property that prevents a Save-for-Later tap from wrongly demoting an existing active plan.
- **not found / not a draft** ([wizard.test.ts:2308-2349](artifacts/api-server/src/routes/__tests__/wizard.test.ts#L2308-L2349)) — 404 when materializer throws `WizardDraftNotFoundError` (covers missing / not owned / already-saved / already-activated — single guard); 401 when no auth.
- **malformed draft** ([wizard.test.ts:2351-2388](artifacts/api-server/src/routes/__tests__/wizard.test.ts#L2351-L2388)) — 422 + `{ error: "draft malformed", reason: "shape_mismatch" }`, matches `/activate`.

Run output: `pass 610 / fail 0 / skipped 2 / tests 612`. tsc clean. Test stub structure reuses `makeActivateDeps` as-is (no fork).

## 6. Smoke

Script: [ws7-5b2-server-smoke.ts](artifacts/api-server/scripts/ws7-5b2-server-smoke.ts). Mirrors `ws7-5b-server-smoke.ts` structure with the activate-specific assertions replaced by save-tail assertions (startDate null, endDate null, isActiveThisWeek false; added a my_plans GET to prove the row appears as undated-inactive).

**Tx elapsed (save tail):**
- Run 1: `[WS7-5b2-smoke] save $transaction elapsed: 13339ms (ok)` (5 meals / 10 dishes / 98 dishIngredients / 62 steps)
- Run 2: `save: 14236ms (ok)` (5 meals / 12 dishes / 102 dishIngredients / 62 steps)

Both well under the 60s budget (~3.5–4.5× headroom). Identical write-volume profile to activate's smoke — confirms the budget transfer was correctly assessed.

**All 8 step results — Run 1 (inlined from REPORT):**

| # | Step | Result |
|---|---|---|
| 1 | `POST /wizard/build-plans` | ✓ 3 candidates, 25860ms |
| 2 | `POST /wizard/expand` (real Anthropic — Sonnet + Haiku macros) | ✓ draftId=9ff76157…, meals=5, dishes=10, 26510ms |
| 3 | `GET /wizard/drafts/:id` | ✓ status=200, mealsInJson=5 |
| 4 | `POST /wizard/drafts/:id/save` | ✓ revisionId=1, 13343ms (tx=13339ms) |
| 5 | DB check — graph + flags | ✓ isWizardDraft=**false**, isActiveThisWeek=**false**, startDate=**null**, endDate=**null**, status=draft, items=5, meals=5, dishes=10, dishIngredients=98, steps=62, withMacros=10/10 |
| 6 | `GET /wizard/drafts` excludes saved | ✓ drafts.length=0, foundSaved=false |
| 7 | `GET /plans?filter=my_plans` includes saved | ✓ my_plans.length=1, foundSaved=true |
| 8 | activity check `plan_created` | ✓ event present for saved id |

**Final**: `Result: PASS`. Cleanup deleted the saved plan via cascade (`prisma.mealPlanInstance.delete`).

**Teardown-twice-clean confirmed.** Re-ran the smoke immediately. Run 2: PASS, save tx=14236ms, all 8 steps green, new draft id, cleanup succeeded. No collisions on `User` row (upsert), no stale rows blocking either run.

**Anthropic call count + cost (per run, real prod traffic):**
- 1× `wizard.set_preferences.generate` (Sonnet) — ~$0.033
- 5× `wizard.candidate.expand` (Sonnet) on the expand step — ~$0.144 aggregate
- 10× `nutrition.ingredient_estimate` (Haiku, one per dish) — ~$0.020 aggregate
- Per-run total: ~$0.20 (verified via `costEstimateUsd` fields in the AI call logs)
- **Two-run total: ~$0.40** for the verification + repeat-clean check.

## 7. Judgment calls / scope decisions (§3)

- **Did not touch `/activate`.** As mandated — `/activate` was verified at real cost in 5b-server; reopening its surface is forbidden. Save is a fully additive sibling route. `git status -- artifacts/api-server/src/routes/wizard.ts` shows the only edit in that file is the new `/save` block + comments; the existing `/activate` block is byte-for-byte unchanged. ✅
- **Did not touch the materializer.** `wizardActivation.ts` shows zero diff. The materializer's split-pass design (non-tx ingredient upserts, tx graph writes) is reused as-is and the same `{ prisma, tx, userId, draftId }` call shape works for save unchanged. ✅
- **Response shape: matched `/activate` 1:1** — `{ instance: { id, revisionId } }`. The smoke confirms `revisionId: 1` for save (no increment). Rationale: the mobile post-save navigation can reuse the same response-handling code as post-activate (both land in My Plans / Plan Review). A larger shape (returning the full instance row, items, etc.) would duplicate work the existing `GET /plans/:id` already does well.
- **Activity metadata: `source: "wizard_draft_save"`** — distinguishes save's `plan_created` from any future non-wizard `plan_created` emissions, mirrors how `/activate` tags its `plan_activated_this_week` with `source: "wizard_draft_activate"`. Funnel analytics can split wizard saves from other create paths without a new enum value.
- **No new error enums / no migration.** `plan_created` already exists in `ActivityEventType` ([schema.prisma:141](artifacts/api-server/prisma/schema.prisma#L141)). The error classes (`WizardDraftNotFoundError`, `WizardDraftMalformedError`) are reused from `wizardActivation.ts`.
- **Tx budget: 60s / 20s maxWait, identical to `/activate`.** Same materializer = same write volume = same exposure. Smoke confirms 13.3s and 14.2s on 10–12 dish loads (well within budget). D-WS7-067 createMany batching will improve both paths simultaneously.
- **Tests: deliberately did NOT re-test the materializer itself.** It's exercised already by the activate tests + the live smoke; re-testing it via save would be redundant. The save tests focus on what's distinct about the route (tail flags + activity event + absence-of-demote).

## 8. CONTRACT for the mobile block

Pin this. The mobile block wires to exactly this shape:

```http
POST /api/wizard/drafts/:id/save
Authorization: Bearer <JWT>
Content-Type: application/json
(no body)
```

**Path param**: `:id` — the wizard draft id returned from `POST /api/wizard/expand` (its `draft.id` field).

**Success — 201 Created**:
```json
{
  "instance": {
    "id": "<uuid — same as the :id param>",
    "revisionId": 1
  }
}
```

After 201, the row appears in `GET /api/plans?filter=my_plans` as **undated** (`startDate: null`, `endDate: null`) and **inactive** (`isActiveThisWeek: false`). It is no longer in `GET /api/wizard/drafts` (the `isWizardDraft` discriminator gate excludes it). To read the full materialized plan, mobile uses the existing `GET /api/plans/:id` path (same `:id`).

**Errors**:

| Code | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid draft id" }` | `:id` missing / >100 chars |
| 401 | `{ "error": "unauthenticated" }` | no/invalid JWT |
| 404 | `{ "error": "draft not found" }` | draft missing, owned by someone else, OR already saved/activated (`isWizardDraft` is `false`) |
| 422 | `{ "error": "draft malformed", "reason": "<zod-path-list>" }` | `optimizationNotes` no longer parses as `WizardExpandedPlan` (data corruption / schema drift) |
| 500 | `{ "error": "failed to save draft" }` | unexpected failure (logged with `event: wizard_draft_save_failed`) |

**Activity emitted**: `plan_created` with `entityType: "MealPlanInstance"`, `entityId: <saved id>`, `metadata: { source: "wizard_draft_save", mealsCreated, itemsCreated }`.

## 9. §27 verification status

**Save tail is CONFIRMED working end-to-end.** Real Anthropic + real Neon RTTs (~170+ writes across Pass 1 ingredient upserts + Pass 2 meal-graph). DB read after save confirms the materialized graph (5 meals, 10–12 dishes, 98–102 dishIngredients, 62 RecipeInstructionSteps, all dishes with macros populated) AND the save-specific flag state (`isWizardDraft: false`, `isActiveThisWeek: false`, dates null, status: "draft"). `plan_created` activity row verified present in DB. `my_plans` filter correctly includes the row; `/wizard/drafts` correctly excludes it. Idempotent teardown verified by a clean second run.

No residual inference. The endpoint is ready for the mobile wiring block.

## 10. Deferrals

None new. (Highest assigned remains **D-WS7-067** — owner WS9 — for the `createMany` batching that would shrink both `/activate` and `/save` Pass 2 RTTs.)

The next deferral, if needed, would be **D-WS7-068**. Not assigned in this slice — the implementation is straightforward additive code with no new gaps.

---

**Sub-phase complete. Ready for `feat(wizard): WS7-5b2 POST /save — promote draft to undated inactive plan` and the mobile-wiring block.**
