# WS7-4-E — Phase 0 audit report (mobile recalc-macros client + AppContext mutator finalization)

**Branch HEAD:** `9772c2f` (WS7-4-D c16, 2026-05-27).
**Mobile tests at audit start:** 246 pass / 0 fail (just verified).
**Server tests:** 575 (per WS7-4-D c16 baseline; no changes proposed here).

Scope: read-only state cross-check + Phase 1 prep. No code changes in this phase.

---

## A1. AppContext plan-mutator inventory ([AppContext.ts](artifacts/kiwi/contexts/AppContext.ts))

The "WS6-era 15+ stubs" map note is **stale**. Current state of the §8/§9 plan-surface mutators:

| # | Mutator | Decl line | Impl lines | State |
|---|---------|-----------|------------|-------|
| 1 | `assignDayToPlanItem` | [79-83](artifacts/kiwi/contexts/AppContext.ts#L79-L83) | [342-353](artifacts/kiwi/contexts/AppContext.ts#L342-L353) | **REAL_API** (WS7-4-D c6 → `patchPlanItem`) |
| 2 | `unassignDayFromPlanItem` | [85-88](artifacts/kiwi/contexts/AppContext.ts#L85-L88) | [355-362](artifacts/kiwi/contexts/AppContext.ts#L355-L362) | **REAL_API** (c6 → `patchPlanItem`) |
| 3 | `addMealToPlan` | [90-94](artifacts/kiwi/contexts/AppContext.ts#L90-L94) | [366-381](artifacts/kiwi/contexts/AppContext.ts#L366-L381) | **REAL_API** (c7 → `postPlanItem`) |
| 4 | `removeMealFromPlan` | [96-99](artifacts/kiwi/contexts/AppContext.ts#L96-L99) | [383-390](artifacts/kiwi/contexts/AppContext.ts#L383-L390) | **REAL_API** (c7 → `deletePlanItem`) |
| 5 | `changeMealForPlanItem` | [101-105](artifacts/kiwi/contexts/AppContext.ts#L101-L105) | [396-407](artifacts/kiwi/contexts/AppContext.ts#L396-L407) | **REAL_API** (c8 → `patchPlanItem` with sole `{ mealId }`) |
| 6 | `changeRecipeForPlanItem` | [107-111](artifacts/kiwi/contexts/AppContext.ts#L107-L111) | [413-426](artifacts/kiwi/contexts/AppContext.ts#L413-L426) | **REAL_API** (c9 → `patchPlanItem`) |
| 7 | `promoteRecipeOverrideToMeal` | [113-116](artifacts/kiwi/contexts/AppContext.ts#L113-L116) | [428-435](artifacts/kiwi/contexts/AppContext.ts#L428-L435) | **REAL_API** (c9 → `promoteItemOverride`) |
| 8 | `findSimilarMeals` | [118](artifacts/kiwi/contexts/AppContext.ts#L118) | [437-443](artifacts/kiwi/contexts/AppContext.ts#L437-L443) | **STUB** (`console.log` + `return []`) |
| 9 | `updatePlanName` | [120](artifacts/kiwi/contexts/AppContext.ts#L120) | [445-452](artifacts/kiwi/contexts/AppContext.ts#L445-L452) | **REAL_API** (WS7-4-C c6 → `patchPlan`) |
| 10 | `updatePlanDateRange` | [122-125](artifacts/kiwi/contexts/AppContext.ts#L122-L125) | [454-464](artifacts/kiwi/contexts/AppContext.ts#L454-L464) | **REAL_API** (c6 → `patchPlan`) |

**Tally: 9 of 10 plan mutators REAL_API; 1 stub (`findSimilarMeals`).**

But every REAL_API mutator above **discards the response** — the `await` resolves on the parsed envelope, then the body is thrown away. None reads `macrosStale`, none fires the recalc endpoint. That is the actual WS7-4-E gap.

(`useTemplateAsPlan` at [575-582](artifacts/kiwi/contexts/AppContext.ts#L575-L582) is a Use-Plan/Template flow, not a §8 plan mutator — out of scope for the "10 plan mutators" target.)

## A2. Mutation response shape — server emits `macrosStale` + `revisionId` everywhere

Server route inspection ([api-server/src/routes/plans.ts](artifacts/api-server/src/routes/plans.ts) + grep above):

| Endpoint | Response | `macrosStale` field |
|---|---|---|
| PATCH `/plans/:id` (plan-level) | `{ instance: { id, revisionId }, macrosStale?: boolean }` | **optional** in schema; server emits boolean in BOTH the noop branch (forced `false`, [879](artifacts/api-server/src/routes/plans.ts#L879)) AND the mutated branch ([865+884](artifacts/api-server/src/routes/plans.ts#L865)) via `planNeedsMacroEstimation(tx)` |
| POST `/plans/:id/items` | `{ item, planId, revisionId, macrosStale }` | **required**, computed in-tx (line 1122) |
| PATCH `/plans/:id/items/:itemId` | `{ item, planId, revisionId, macrosStale }` | **required**; noop branch forces `false` (1739), mutated branch reads `planNeedsMacroEstimation` (1485, 1685) |
| DELETE `/plans/:id/items/:itemId` | `{ planId, revisionId, macrosStale }` | **required**, in-tx (1279) |
| POST `/plans/:id/items/:itemId/promote-override` | `{ item, planId, revisionId, macrosStale, newMealId }` | **required**, in-tx (1884) |

Mobile schemas already parse all of these — see [lib/api/plans.ts](artifacts/kiwi/lib/api/plans.ts):
- `PlanItemMutationResponseSchema` ([290-295](artifacts/kiwi/lib/api/plans.ts#L290-L295)): `macrosStale: z.boolean()` (required)
- `PlanItemDeleteResponseSchema` ([300-304](artifacts/kiwi/lib/api/plans.ts#L300-L304)): same
- `PromoteItemOverrideResponseSchema` ([309-311](artifacts/kiwi/lib/api/plans.ts#L309-L311)): same + `newMealId`
- `PatchPlanResponseSchema` ([177-180](artifacts/kiwi/lib/api/plans.ts#L177-L180)): `macrosStale: z.boolean().optional()`
- `revisionId` is echoed on every endpoint (Ruling 13 — already wired into the schemas)

**The schemas are ready. What the AppContext mutators don't do today: read the parsed flag and dispatch on it.**

## A3. `changeMealForPlanItem` wiring state

Already wired to REAL_API at [AppContext.ts:396-407](artifacts/kiwi/contexts/AppContext.ts#L396-L407). Calls `patchPlanItem(planId, planItemId, { mealId: newMealId })` per Q-P1-4 v1 (sole-field PATCH). Test at [AppContext.mutators.test.ts:757](artifacts/kiwi/contexts/__tests__/AppContext.mutators.test.ts#L757) covers wire shape and error propagation. **No work needed here for the wiring** — only the `macrosStale` consumption upgrade applies.

## A4. Retirement targets (Ruling 7)

**Both already retired in WS7-4-D c9.** Re-running the grep now:

```
grep -rn "swapMealInCurrentPlan|getRecipe" artifacts/kiwi/ --include="*.ts" --include="*.tsx"
```

Hits:
- `artifacts/kiwi/contexts/__tests__/AppContext.mutators.test.ts:807,812,814` — the retirement assertion test (asserts absence on `AppContext` value). **Not a live caller.**
- Zero matches in `artifacts/kiwi/contexts/AppContext.ts`, `artifacts/kiwi/lib/stubs.ts`, or anywhere else.
- `getRecipe` grep across `artifacts/kiwi` returns zero matches anywhere.

**Implication for WS7-4-E:** Ruling 7 is already done. There is no `changeMealForPlanItem`-wiring-plus-retirement commit to land. **Surface in Phase 1: the WS7-4-E prompt's framing here is stale.** No regression risk — the existing retirement assertion test stays green.

## A5. Existing loading-indicator pattern

[`LoadingShim`](artifacts/kiwi/components/LoadingShim.tsx) — purpose-built shared component (WS7-1) with three variants:
- `status-box` — large card, for full-screen mutation states (e.g. wizard-results pending).
- `screen` — full-bleed, for full-screen route loading (e.g. Plan Review's initial fetch at [plan/[id].tsx:314](artifacts/kiwi/app/plan/[id].tsx#L314)).
- **`inline`** — small horizontal row: sage `ActivityIndicator size="small"` + label text. Used today by `tellkiwi.tsx` thinkingRow and `FindSimilarSheet.tsx` loadingCard.

The `inline` variant is the canonical "non-blocking" idiom. **Reuse it for the macros panel.** No new component, no new dep.

## A6. macrosStale round-trip (both directions verified)

**Direction 1 — mutation → client reads flag:**
- Server: emits `macrosStale: boolean` on all 7 mutating endpoints (A2 above; line numbers cited from grep).
- Schema: mobile parses it on all 5 item endpoints (required) and on the plan endpoint (optional). [lib/api/plans.ts:290-311](artifacts/kiwi/lib/api/plans.ts#L290-L311) for items, [177-180](artifacts/kiwi/lib/api/plans.ts#L177-L180) for plan.
- Reader: **the AppContext mutators do not read the parsed flag today.** They `await` then invalidate. (That's the WS7-4-E gap.)

**Direction 2 — client fires recalc → renders fresh macros:**
- No mobile helper for POST `/plans/:id/recalc-macros` exists in `lib/api/plans.ts` today (verified by grep across `artifacts/kiwi`; the string `recalc-macros` lives only in api-server/ and the audit reports). **Must be added in c1.**
- Server endpoint returns `PlanMacrosResult` ([planMacros.ts:82-89](artifacts/api-server/src/lib/planMacros.ts#L82-L89)): `{ dailyAverages: DailyMacros, perDay, perMeal, computedAt, hasEstimatedMacros, estimationCaveats }`. `DailyMacros` shape matches `MacroDailyAverage` on the mobile side ([lib/api/plans.ts:99-104](artifacts/kiwi/lib/api/plans.ts#L99-L104)) — same field names (`caloriesPerDay`, `proteinGPerDay`, `carbsGPerDay`, `fatGPerDay`).
- Side-effect: `computePlanMacros` persists fresh per-serving macros back to the `Dish` rows for any item with no overrides ([planMacros.ts:339-366](artifacts/api-server/src/lib/planMacros.ts#L339-L366)). GET `/plans/:id` rebuilds `macroDailyAverage` from those cached Dish macros via `computeMacroDailyAverage(items)` ([routes/plans.ts:80-108, 338](artifacts/api-server/src/routes/plans.ts#L80)). So an invalidate-after-recalc surfaces the fresh values without any client-side merging.

**Round-trip viable end to end. Both halves cited above.**

---

## A7. Anomalies / drift surfaced

- **A7.1 (Ruling 7 framing drift):** The WS7-4-E prompt says Ruling 7 retirement runs "in the same commit that wires `changeMealForPlanItem` to REAL_API." Both happened in WS7-4-D c9 (c8 + c9 actually — c8 wired, c9 retired in same block). The Phase 1 plan no longer needs that commit.
- **A7.2 (stale stub note):** The codebase map's "15+ stubs (WS7 swap pending)" line is from a WS6-era inventory. Actual state at HEAD: 1 plan-mutator stub (`findSimilarMeals`), plus several non-plan stubs (`saveDish`, grocery-list mutators `toggleGroceryItemCompleted` / `toggleGroceryStapleSelection` / `removeGroceryItem` / `markGroceryShoppingDone` — all PRD §12, out of WS7-4-E scope).
- **A7.3 (`findSimilarMeals` is dead code — judgment call):** Grep across `artifacts/kiwi` for `\.findSimilarMeals\(` or `findSimilarMeals,` returns:
  - `AppContext.ts:745` — the value re-export
  - `hooks/useFindSimilarMeals.ts:4,11` — imports `findSimilarMeals` directly from `lib/api/meals` (not from AppContext)
  No consumer calls `useApp().findSimilarMeals()`. The real Find Similar flow runs through `useFindSimilarMeals` → `lib/api/meals.ts` → POST `/meals/find-similar` (the AI semantic ranking, server-side); the `FindSimilarSheet` uses `findSimilarMealsByCuisine` from `lib/stubs.ts` for free-tier cuisine matching. **The AppContext stub is orphaned, exactly like `swapMealInCurrentPlan` was pre-c9.** Recommend retirement, not wiring. Question Q1 below.
- **A7.4 (no server change needed):** The flag emit and the recalc endpoint both exist. The Plan Review GET payload already carries the recomputed `macroDailyAverage` on refresh. WS7-4-E is mobile-only.

---

## Phase 1 judgment calls for Hans to rule on

**Q1. `findSimilarMeals` — retire or wire?**
The mutator is a console.log stub with zero callers (A7.3). The "completion target = no console.log-only mutator stubs remain" framing is satisfied either by retirement or by wiring. Real Find Similar already goes around it.
- (A) **Retire** (mirror of `swapMealInCurrentPlan` c9: same pre-deletion grep proof; interface line, impl, value re-export removed in one commit; runtime assertion test added). Lands the "no stubs" target without re-introducing dead code. **My recommendation.**
- (B) Wire to POST `/meals/find-similar` (the existing AI ranking endpoint). Adds parallel/duplicate plumbing alongside `useFindSimilarMeals` for no consumer.
- (C) Wire to a cuisine-match query (no server endpoint exists for "meals by cuisine" today; would require either a client filter over `getMeals` or a new server route — that's WS7-5 scope).

**Q2. Loading-indicator placement on the macros panel.**
The macros card is at [plan/[id].tsx:482-512](artifacts/kiwi/app/plan/[id].tsx#L482-L512). All three placements use `<LoadingShim variant="inline" label="Updating macros…" />`. Mockups for comparison:

- (A) **Inline-above-row** (recommended). Renders the shim ABOVE the macro values when a recalc is in flight; values stay visible (potentially stale-but-readable, matches PRD redline's "brief loading state while AI estimates"). Minimal layout shift; mounts/unmounts in ~3s.
- (B) **Replace-row-while-stale.** Replaces the four-stat row with the inline shim during recalc. Stronger signal that values are computing, but the user loses readability of last-known values.
- (C) **Glyph-beside-title.** Tiny spinner adjacent to the "Daily averages" title. Subtlest; values stay visible. Doesn't reuse `LoadingShim inline` cleanly (would mean an ad-hoc `ActivityIndicator`).

**Q3. Plan-level mutator scope.** `updatePlanName` and `updatePlanDateRange` both PATCH `/plans/:id`, and the response schema's `macrosStale` is optional but present (server emits it). Should both consume the flag? Recommended **YES** for symmetry — even though a name-only change can never go stale, the noop branch returns `false` and a real change carries the genuine value; the read-and-dispatch code path is identical. (If you prefer to only wire the date-range mutator, that's a one-line difference in the c2 plan.)

---

## Proposed Phase 1 execution plan (pending Hans's rulings)

Single block expected. Mobile-only.

**c1 — `recalcPlanMacros` API helper.**
Add to [lib/api/plans.ts](artifacts/kiwi/lib/api/plans.ts):
- `RecalcPlanMacrosResponseSchema` parsing at minimum `{ dailyAverages: { caloriesPerDay, proteinGPerDay, carbsGPerDay, fatGPerDay } }` (other fields `.passthrough()` or omitted — the mobile UI consumes daily averages only per PRD §8.3.5 LOCKED).
- `recalcPlanMacros(planId): Promise<RecalcPlanMacrosResponse>` — POST `/plans/:id/recalc-macros`, no body, schema-validated.
Tests: + 1 (helper schema happy path under the existing `lib/api/plans.test.ts` if one exists; otherwise minimal smoke in the AppContext test).

**c2 — Hybrid recalc wiring across 7 mutators in AppContext.**
Pattern (applied to all 7 mutators below):
```
const response = await <helper>(...);
queryClient.invalidateQueries(["plans", planId]);
queryClient.invalidateQueries(["plans"]);
if (response.macrosStale) {
  void fireRecalc(planId);  // tracked via setMacrosRecalcInFlight counter
}
```
Where `fireRecalc(planId)`:
1. increments an in-flight counter (state)
2. calls `recalcPlanMacros(planId)`
3. on success: `queryClient.invalidateQueries(["plans", planId])` → re-fetches with fresh `macroDailyAverage`
4. on failure: `console.warn` only — does NOT throw or rollback; the mutation already succeeded
5. always: decrements the counter

Expose `isMacrosRecalcInFlight: boolean` (= counter > 0) on `AppState`.

Mutators wired: `assignDayToPlanItem`, `unassignDayFromPlanItem`, `addMealToPlan`, `removeMealFromPlan`, `changeMealForPlanItem`, `changeRecipeForPlanItem`, `promoteRecipeOverrideToMeal` (the 5 item endpoints). Optionally `updatePlanName` and `updatePlanDateRange` pending Q3.

Tests (in `AppContext.mutators.test.ts`):
- `+1` macrosStale=true on PATCH /items triggers POST /recalc-macros
- `+1` macrosStale=false does NOT trigger /recalc-macros
- `+1` recalc-macros failure does NOT throw / does NOT crash the mutator (mutator resolves cleanly)
- `+1` `isMacrosRecalcInFlight` flips true during recalc and back to false after

Mobile test target: 246 + 4 = **250** (more if Q3 = YES expansion).

**c3 — Macros-panel loading shim on Plan Review.**
[plan/[id].tsx](artifacts/kiwi/app/plan/[id].tsx) macros card ([482-512](artifacts/kiwi/app/plan/[id].tsx#L482-L512)). Render `<LoadingShim variant="inline" label="Updating macros…" />` per Q2 ruling. Pulls `isMacrosRecalcInFlight` from `useApp()`. No new state in the screen.

No new mobile test (UI rendering test is not how this harness asserts today). Will smoke-verify by reading the diff and confirming the conditional render shape.

**c4 — (only if Q1 = retire) `findSimilarMeals` retirement.**
Pre-deletion grep re-run (commit body pastes output). Remove interface line, impl, value re-export. Mirror the c9 retirement-assertion test pattern: `+1` test asserting `"findSimilarMeals" in v === false`. Mobile test target after c4: **+1 = 251**.

If Q1 = wire (B or C), this becomes a different commit shape and may require server work (out of WS7-4-E scope).

**Single block, 3 or 4 commits.** All mobile-only. Server tests stay at 575.

---

## Stop-and-ask gate

Three Phase 1 rulings (Q1 / Q2 / Q3) need Hans's call before c1 lands. Will proceed to Phase 2 only after rulings.
