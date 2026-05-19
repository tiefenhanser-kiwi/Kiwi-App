# WS7-PRE — Read-only audit report

**Run:** 2026-05-18
**HEAD:** `7c2b385` (`[WS6-6-CLOSE] Cap caveats at 80 chars in meal_builder.assist_steps prompt body`)
**Working tree:** clean (only untracked file `artifacts/api-server/scripts/fixtures/.recipe-card-validated` sentinel — fixture-scaffolding marker, not a modification)
**Auditor note:** Project-knowledge docs (`kiwi_navigation.md`, `kiwi_codebase_map.md`, `kiwi_remediation_progress.md`, `kiwi_ws6_complete_handoff.md`, `kiwi_active_prompts.md`, `kiwi_deferred_decisions_log.md`, `kiwi_working_agreements.md`) are not reachable from this Claude Code session — they live chat-Claude-side. This audit worked from repo state + `attached_assets/kiwi_ws6_plan.md` per memory note ([WS6 deferral numbering]). All §A-§L claims trace to file:line in the working tree; statements that depend on a chat-side doc are flagged explicitly.

---

## Executive summary

WS7's load is **mostly persistence and mobile-side wiring, not new AI**. All twelve WS6 AI endpoints are in place server-side; the gap is that **the mobile app has wired only the read-side and import-side of those endpoints, not the persistence side**, and **most plan/dish/account mutation endpoints don't exist server-side yet**. Top blockers for plan-lock: (1) wizard candidates have no save-commit path — `handleUsePlan` just navigates to `/plan/[id]?id=demo-plan-just-created` (a stub plan ID), (2) Plan Review reads from `getReviewPlan()` stub returning demo fixtures or empty plans, with all 12 plan-mutation callbacks logging to `console.log` and (3) the three known reconciliation drifts (D-WS6-029 recalc-macros shape, D-WS6-034 parallelGroup type, D-WS6-036 cuisine-case) are all still present and must be resolved before persistence wiring fans out. The repo is in a clean, well-instrumented state — every stub callsite is annotated with `TODO(WS7)` markers and the API-client scaffold is ready to extend.

---

## §A — API surface inventory

Wiring state values: `WIRED_REAL` = mobile fetches with real payload; `WIRED_STUB` = mobile call layered on a stub; `STUB_ALERT` = `Alert.alert("Coming…")` or `console.log` instead of call; `NOT_WIRED` = server-only; `SERVER_MISSING` = endpoint absent.
Smoke state values: `SMOKE_PASSED` = end-to-end evidence; `SMOKE_SERVER_ONLY` = server smoke only; `UNKNOWN`; `N/A`.

### AI endpoints (per WS6 plan §3)

| Endpoint | Server: exists? | Mobile callsite | Wiring | Smoke |
|---|---|---|---|---|
| POST /wizard/build-plans | ✅ [wizard.ts:187](../src/routes/wizard.ts#L187) | ✅ [hooks/useBuildWizardPlans.ts:11](../../kiwi/hooks/useBuildWizardPlans.ts#L11) → [wizard-results.tsx:78](../../kiwi/app/wizard-results.tsx#L78); calls [lib/api/wizard.ts:24](../../kiwi/lib/api/wizard.ts#L24) | WIRED_REAL | SMOKE_PASSED (6a-5 + Hans manual) |
| POST /wizard/build-from-text | ✅ [wizard.ts:299](../src/routes/wizard.ts#L299) | ✅ [hooks/useBuildFromText.ts:11](../../kiwi/hooks/useBuildFromText.ts#L11) → [tellkiwi.tsx:117](../../kiwi/app/tellkiwi.tsx#L117); calls [lib/api/tellKiwi.ts:53](../../kiwi/lib/api/tellKiwi.ts#L53) | WIRED_REAL | SMOKE_PASSED (6a-5) |
| POST /meals/find-similar | ✅ [meals.ts:128](../src/routes/meals.ts#L128) | Hook exists at [hooks/useFindSimilarMeals.ts:11](../../kiwi/hooks/useFindSimilarMeals.ts#L11) BUT [components/FindSimilarSheet.tsx:131](../../kiwi/components/FindSimilarSheet.tsx#L131) still uses `findSimilarMealsByCuisine` stub from [lib/stubs.ts:2078](../../kiwi/lib/stubs.ts#L2078). | WIRED_STUB | SMOKE_SERVER_ONLY (mobile never swapped) |
| POST /plans/:id/recalc-macros | ✅ [plans.ts:60](../src/routes/plans.ts#L60) | None (grep `recalc-macros` returns zero mobile hits). Endpoint is callable but no consumer; D-WS5-007/D-WS6-029 both flag WS7 wiring. | NOT_WIRED | SMOKE_SERVER_ONLY |
| POST /builder/assist-ingredients | ✅ [builder.ts:73](../src/routes/builder.ts#L73) | None. Dish Builder checkboxes (D-WS6-031) flip local state only. | NOT_WIRED | SMOKE_SERVER_ONLY |
| POST /builder/assist-steps | ✅ [builder.ts:124](../src/routes/builder.ts#L124) | None. Same as above. | NOT_WIRED | SMOKE_SERVER_ONLY |
| POST /builder/parse-meal | ✅ [builder.ts:176](../src/routes/builder.ts#L176) | Mode A card in [meal-builder.tsx:578](../../kiwi/app/meal-builder.tsx#L578) is a locked stub Alert (D-WS6-032). | STUB_ALERT | SMOKE_SERVER_ONLY |
| POST /recipes/import-url | ✅ [recipes.ts:118](../src/routes/recipes.ts#L118) | ✅ [import-url.tsx:69](../../kiwi/app/import-url.tsx#L69) → [lib/api/recipeImport.ts:412](../../kiwi/lib/api/recipeImport.ts#L412) | WIRED_REAL | SMOKE_PASSED (6c-1) — but save step missing (D-WS6-088) |
| POST /recipes/import-image | ✅ [recipes.ts:243](../src/routes/recipes.ts#L243) | ✅ [import-image.tsx:91](../../kiwi/app/import-image.tsx#L91) → [lib/api/recipeImport.ts:523](../../kiwi/lib/api/recipeImport.ts#L523) | WIRED_REAL | SMOKE_PASSED (6c-2) — save step missing |
| POST /recipes/import-text | ✅ [recipes.ts:356](../src/routes/recipes.ts#L356) | ✅ [import-text.tsx:41](../../kiwi/app/import-text.tsx#L41) → [lib/api/recipeImport.ts:610](../../kiwi/lib/api/recipeImport.ts#L610) | WIRED_REAL | SMOKE_PASSED (6c-3) — save step missing |
| POST /recipes/scale | ✅ [recipes.ts:46](../src/routes/recipes.ts#L46) | ✅ helper in [lib/api.ts:22](../../kiwi/lib/api.ts#L22); consumer presumed [meal/[id].tsx](../../kiwi/app/meal/[id].tsx) servings stepper (not verified end-to-end this audit) | WIRED_REAL (suspected) | UNKNOWN |
| POST /plans/:id/generate-grocery-list | ✅ [groceryLists.ts:129](../src/routes/groceryLists.ts#L129) | ✅ [plan/[id].tsx:257](../../kiwi/app/plan/[id].tsx#L257) → [lib/api/grocery.ts:38](../../kiwi/lib/api/grocery.ts#L38) | WIRED_REAL | SMOKE_PASSED (6c-5) |
| GET /grocery-items/lookup | ✅ [groceryLists.ts:344](../src/routes/groceryLists.ts#L344) | ✅ [grocery-list/[id].tsx:125](../../kiwi/app/grocery-list/[id].tsx#L125) → [lib/api/grocery.ts:248](../../kiwi/lib/api/grocery.ts#L248) | WIRED_REAL | SMOKE_PASSED (6c-6 Block B) |
| POST /grocery-lists/:id/items | ✅ [groceryLists.ts:414](../src/routes/groceryLists.ts#L414) | ✅ [AppContext.tsx:474](../../kiwi/contexts/AppContext.tsx#L474) → [lib/api/grocery.ts:316](../../kiwi/lib/api/grocery.ts#L316); consumed by [grocery-list/[id].tsx](../../kiwi/app/grocery-list/[id].tsx) | WIRED_REAL | SMOKE_PASSED (6c-6 Block C) |
| POST /meals/:mealId/cooking-sequence | ✅ [cooking.ts:82](../src/routes/cooking.ts#L82) | None (D-WS6-089). [prep-cook.tsx](../../kiwi/app/prep-cook.tsx) is a static "Coming with Prep & Cook Hub" page. | NOT_WIRED | SMOKE_SERVER_ONLY |
| POST /plans/:planId/prep-week | ✅ [cooking.ts:138](../src/routes/cooking.ts#L138) | None. Same prep-cook stub. | NOT_WIRED | SMOKE_SERVER_ONLY |
| POST /wizard/build-cook-now (or equivalent) | ❌ Not in [routes/index.ts](../src/routes/index.ts). `wizard.cook_now.generate` prompt key is seeded in WS6 but no route handler binds to it. | [cook-now.tsx](../../kiwi/app/cook-now.tsx) is a static "Coming soon" placeholder. | SERVER_MISSING + NOT_WIRED | N/A |

### Persistence endpoints expected for WS7

| Endpoint | Server | Mobile | Wiring | Smoke |
|---|---|---|---|---|
| GET /me/preferences | ❌ | Reads from [stubs.ts:2194 `getCurrentUserPreferences()`](../../kiwi/lib/stubs.ts#L2194) | SERVER_MISSING | N/A |
| PATCH /me/preferences | ❌ | [AppContext.tsx:434 `updateUserPreferences`](../../kiwi/contexts/AppContext.tsx#L434) is `console.log` only | SERVER_MISSING | N/A |
| PATCH /me {name,email,phone,password} | ❌ (only `/me/ui-state` exists at [me.ts:23](../src/routes/me.ts#L23)) | [AppContext.tsx:416-429](../../kiwi/contexts/AppContext.tsx#L416-L429) `updateUserName/Email/Phone` are all `console.log` stubs; consumed by [profile.tsx:87-112](../../kiwi/app/(tabs)/profile.tsx#L87-L112) | SERVER_MISSING | N/A |
| POST /me/deactivate (soft-delete + 6-month) | ❌ | [AppContext.tsx:438](../../kiwi/contexts/AppContext.tsx#L438) `deactivateAccount` is `console.log` only; [deactivate-account.tsx:50](../../kiwi/app/deactivate-account.tsx#L50) calls it | SERVER_MISSING | N/A |
| POST /plans (create empty) | ❌ | Wizard "Use this plan" at [wizard-results.tsx:156](../../kiwi/app/wizard-results.tsx#L156) just `router.push`-es to `demo-plan-just-created`; no persistence | SERVER_MISSING | N/A |
| GET /plans (list user's plans) | ❌ | [stubs.ts:2106 `getUserPlans()`](../../kiwi/lib/stubs.ts#L2106) returns fixtures; consumed by Home + plans tab | SERVER_MISSING | N/A |
| GET /plans/:id (composite Review payload) | ❌ | [stubs.ts:291 `getReviewPlan()`](../../kiwi/lib/stubs.ts#L291) returns demo or empty plan; consumed at [plan/[id].tsx:32](../../kiwi/app/plan/[id].tsx#L32) | SERVER_MISSING | N/A |
| PATCH /plans/:id (rename, dates) | ❌ | [AppContext.tsx:390 `updatePlanName`](../../kiwi/contexts/AppContext.tsx#L390), [.tsx:399 `updatePlanDateRange`](../../kiwi/contexts/AppContext.tsx#L399) mutate in-memory cache via [stubs.ts:303,313](../../kiwi/lib/stubs.ts#L303-L313) | SERVER_MISSING | N/A |
| DELETE /plans/:id | ❌ | Not surfaced in mobile yet | SERVER_MISSING | N/A |
| POST /plans/:id/items (add meal) | ❌ | [AppContext.tsx:339 `addMealToPlan`](../../kiwi/contexts/AppContext.tsx#L339) `console.log` only | SERVER_MISSING | N/A |
| PATCH /plans/:id/items/:itemId (assign day, change meal, swap recipe, override servings/ingredients) | ❌ | [AppContext.tsx:322,331,356,365](../../kiwi/contexts/AppContext.tsx#L322-L372) all `console.log` only | SERVER_MISSING | N/A |
| DELETE /plans/:id/items/:itemId (remove) | ❌ | [AppContext.tsx:348](../../kiwi/contexts/AppContext.tsx#L348) `console.log` only | SERVER_MISSING | N/A |
| POST /plans/:id/items/:itemId/promote-override (promote `recipeOverrideJson` into Meal) | ❌ | [AppContext.tsx:374](../../kiwi/contexts/AppContext.tsx#L374) `console.log` only | SERVER_MISSING | N/A |
| Wizard candidate expansion + save-commit (D-WS6-027) | ❌ | Today wizard candidates carry titles only; no expansion path; no commit; `handleUsePlan` navigates to stub | SERVER_MISSING | N/A |
| POST recipe save (D-WS6-088: Meal + Dish + MealDishLink + per-dish RecipeInstructionStep with `ownerType:"dish"`) | ❌ | [meal-builder.tsx:464-498](../../kiwi/app/meal-builder.tsx#L464-L498) shows multiple "Coming in WS7" Alert.alerts on save buttons | SERVER_MISSING | N/A |
| POST/PATCH /me/dishes (create/update dish) | ❌ | [AppContext.tsx:409](../../kiwi/contexts/AppContext.tsx#L409) `saveDish` returns synthetic ID via `console.log`; consumed at [dish-builder.tsx:300](../../kiwi/app/dish-builder.tsx#L300) | SERVER_MISSING | N/A |
| GET /me/dishes (list) | ❌ | [stubs.ts:1521 `getSavedDishes()`](../../kiwi/lib/stubs.ts#L1521) returns fixtures | SERVER_MISSING | N/A |
| DELETE /me/dishes/:id (soft-delete) | ❌ | [dish/[id].tsx:88](../../kiwi/app/dish/[id].tsx#L88) shows `Alert.alert("Coming in WS7", "Soft-deleting dishes requires the API client.…")` | SERVER_MISSING | N/A |
| GET /me/meals (list saved meals) | ❌ | [stubs.ts:1818 `getSavedMeals()`](../../kiwi/lib/stubs.ts#L1818) returns fixtures | SERVER_MISSING | N/A |
| GET /grocery-lists (list all for user) | ❌ (only `:id` endpoint exists) | [stubs.ts:2263 `getGroceryLists()`](../../kiwi/lib/stubs.ts#L2263) returns fixtures; consumed by [tabs/groceries.tsx:35](../../kiwi/app/(tabs)/groceries.tsx#L35) | SERVER_MISSING | N/A |
| PATCH /grocery-lists/:id/items/:itemId (toggle complete, edit qty, staple selection) | ❌ | [AppContext.tsx:455,463,491](../../kiwi/contexts/AppContext.tsx#L455-L495) all `console.log` only; [grocery-list/[id].tsx:312](../../kiwi/app/grocery-list/[id].tsx#L312) has explicit `TODO(WS7)` for quantity edit | SERVER_MISSING | N/A |
| DELETE /grocery-lists/:id/items/:itemId | ❌ | [AppContext.tsx:483](../../kiwi/contexts/AppContext.tsx#L483) `console.log` only | SERVER_MISSING | N/A |
| PATCH /grocery-lists/:id { status } (mark shopping done) | ❌ | [AppContext.tsx:491](../../kiwi/contexts/AppContext.tsx#L491) `console.log` only | SERVER_MISSING | N/A |
| PATCH /grocery-lists/:id/sync-with-plan (D-WS5-038 cases 2-4) | ❌ | Not surfaced | SERVER_MISSING | N/A |

### Auth endpoints (for completeness — already WIRED_REAL from WS2)

| Endpoint | Server | Mobile | Wiring |
|---|---|---|---|
| POST /auth/signup | ✅ [auth.ts:91](../src/routes/auth.ts#L91) | ✅ [AuthContext.tsx:98](../../kiwi/contexts/AuthContext.tsx#L98) via [lib/auth.ts](../../kiwi/lib/auth.ts) | WIRED_REAL |
| POST /auth/login | ✅ [auth.ts:148](../src/routes/auth.ts#L148) | ✅ [AuthContext.tsx:84](../../kiwi/contexts/AuthContext.tsx#L84) | WIRED_REAL |
| POST /auth/logout | ✅ [auth.ts:206](../src/routes/auth.ts#L206) | ✅ [AuthContext.tsx:133](../../kiwi/contexts/AuthContext.tsx#L133) | WIRED_REAL |
| POST /auth/password-reset/{request,confirm} | ✅ [auth.ts:214,242](../src/routes/auth.ts#L214-L242) | Not yet wired in mobile UI (no "Forgot password" callsite visible) | NOT_WIRED |
| GET /auth/me | ✅ [auth.ts:275](../src/routes/auth.ts#L275) | ✅ [AuthContext.tsx:61](../../kiwi/contexts/AuthContext.tsx#L61) (bootstrap) | WIRED_REAL |
| PATCH /me/ui-state | ✅ [me.ts:23](../src/routes/me.ts#L23) | ✅ [AuthContext.tsx:152](../../kiwi/contexts/AuthContext.tsx#L152) `setUiState` (debounced) | WIRED_REAL |

---

## §B — `lib/stubs.ts` inventory

`lib/stubs.ts` is 2,373 lines. Exports below (omitting helpers like `asPlanDiscoveryFilters` that are pure type narrowers and have no API counterpart).

| Export (file:line) | Current behavior | Consumers | Real-API replacement | Persistence target |
|---|---|---|---|---|
| `RECIPES` (30) | Empty array | none (legacy) | delete | N/A |
| `getRecipe(id)` (33) | Returns `undefined` | none | delete | N/A |
| `defaultPlan()` (40) | Empty `MealPlan` scaffold (DAYS × empty Dinner slot) | [AppContext.tsx:237](../../kiwi/contexts/AppContext.tsx#L237) on fresh install | `POST /plans` to create empty plan, then `GET /plans/:id` | `MealPlanInstance` |
| `buildGroceryList(plan)` (55) | Returns `[]` | [AppContext.tsx:268](../../kiwi/contexts/AppContext.tsx#L268) (derives legacy `groceries`) | `POST /plans/:id/generate-grocery-list` already wired separately; the legacy `groceries` field on AppContext is parallel-to-new code and should be eliminated | N/A (legacy path) |
| `getHomePayload()` (115) | Returns `{ planDiscoveryCards: [] }` | [PlanDiscoveryCard.tsx](../../kiwi/components/PlanDiscoveryCard.tsx) | New composite `GET /home` endpoint with featured/top-rated/hosting filtering | Read-only |
| `getPlansPayload()` (131) | Returns `{ plans: [] }` | [tabs/plans.tsx](../../kiwi/app/(tabs)/plans.tsx) | `GET /plans?filter=...` | Read-only |
| `getMealsPayload()` (154) | Returns `{ meals: [] }` | [tabs/meals.tsx](../../kiwi/app/(tabs)/meals.tsx) | `GET /me/meals?filter=...` | Read-only |
| `getReviewPlan(planId)` (291) | In-memory cached fixture (demo branches for "demo" / "demo-plan-just-created"; empty otherwise) | [plan/[id].tsx:32](../../kiwi/app/plan/[id].tsx#L32) | `GET /plans/:id` composite | `MealPlanInstance` + `MealPlanItem` + Meal/Dish reads |
| `updateReviewPlanName(planId, name)` (303) | Mutates in-memory cache | [AppContext.tsx:396](../../kiwi/contexts/AppContext.tsx#L396) | `PATCH /plans/:id` | `MealPlanInstance.titleOverride` |
| `updateReviewPlanDateRange(planId, s, e)` (313) | Mutates in-memory cache | [AppContext.tsx:405](../../kiwi/contexts/AppContext.tsx#L405) | `PATCH /plans/:id` | `MealPlanInstance.startDate/endDate` |
| `getMealById(mealId, overrideContext?)` (336) | 5 hand-built demo meals (`demo-meal-1..5`, `featured-meal-1..3`); returns `null` otherwise | [meal/[id].tsx](../../kiwi/app/meal/[id].tsx); [plan/[id].tsx:32](../../kiwi/app/plan/[id].tsx#L32) | `GET /meals/:id` (already exists at [recipes.ts:481](../src/routes/recipes.ts#L481) — `Meal.id`-keyed). Mobile must consume. | Read-only |
| `getSavedDishes()` (1521) | Fixture array | [dish/[id].tsx:25](../../kiwi/app/dish/[id].tsx#L25), [DishChooserSheet.tsx:23](../../kiwi/components/DishChooserSheet.tsx#L23) | `GET /me/dishes` | Read-only |
| `getFeaturedDishes()` (1677), `getTopRatedDishes()` (1769) | Fixture arrays | [dish/[id].tsx:26-27](../../kiwi/app/dish/[id].tsx#L26-L27) | `GET /dishes?filter=featured/top_rated` (NEW endpoint) | Read-only |
| `getSavedMeals()` (1818) | Fixture array | [tabs/meals.tsx](../../kiwi/app/(tabs)/meals.tsx), [ChangeMealSheet.tsx](../../kiwi/components/ChangeMealSheet.tsx) | `GET /me/meals` | Read-only |
| `getFeaturedMeals()` (1905), `getTopRatedMeals()` (1968), `getHostingMeals()` (2017) | Fixture arrays | [FindSimilarSheet.tsx](../../kiwi/components/FindSimilarSheet.tsx) (candidate-union pool), discovery cards | `GET /meals?filter=...` (NEW endpoints — or fold into a single composite) | Read-only |
| `findSimilarMealsByCuisine(mealId)` (2078) | Cuisine-string filter on union of saved/featured/top-rated/hosting | [FindSimilarSheet.tsx:131](../../kiwi/components/FindSimilarSheet.tsx#L131) | Server-side `POST /meals/find-similar` already exists + hook wired in [useFindSimilarMeals.ts](../../kiwi/hooks/useFindSimilarMeals.ts) — switch the FindSimilarSheet consumer | N/A (kept as fallback path on AI-fail per PRD §8.4) |
| `getUserPlans()` (2106) | Fixture array of `UserPlanSummary` | [tabs/index.tsx:74](../../kiwi/app/(tabs)/index.tsx#L74), [AddMealToPlanSheet.tsx:15](../../kiwi/components/AddMealToPlanSheet.tsx#L15) | `GET /plans` | Read-only |
| `getCurrentActivePlan()` (2143) | Returns `null` | [tabs/index.tsx:73](../../kiwi/app/(tabs)/index.tsx#L73) (Hero card) | `GET /plans/current` (or filtered `GET /plans`) | Read-only |
| `getTodaysMeal()` (2151) | Returns `null` | [tabs/index.tsx:72](../../kiwi/app/(tabs)/index.tsx#L72) (Hero card) | `GET /plans/today` (NEW) | Read-only |
| `getCurrentUserInfo()` (2164) | Returns fixture `UserAccountInfo` | [profile.tsx:20](../../kiwi/app/(tabs)/profile.tsx#L20) | Already served by `GET /auth/me` — refactor mobile to consume `user` from `useAuth()` | N/A |
| `getCurrentSubscription()` (2178) | Returns fixture `SubscriptionInfo` | [profile.tsx:20](../../kiwi/app/(tabs)/profile.tsx#L20), [manage-account.tsx:9](../../kiwi/app/manage-account.tsx#L9) | `GET /auth/me` already returns `subscription` shape; consume from auth state | N/A |
| `getCurrentUserPreferences()` (2194) | Returns fixture `UserPreferencesData` | [preferences.tsx:33](../../kiwi/app/preferences.tsx#L33), [onboarding-step-3.tsx:18](../../kiwi/app/onboarding-step-3.tsx#L18) | `GET /me/preferences` (NEW) | `UserPreferences` table |
| `getGroceryLists()` (2263) | Fixture array | [tabs/groceries.tsx:35](../../kiwi/app/(tabs)/groceries.tsx#L35) | `GET /grocery-lists` (NEW — currently only `:id` exists) | Read-only |
| `getGroceryListById(id)` (2297) | Fixture branches (`demo-grocery-*`) | [grocery-list/[id].tsx:67](../../kiwi/app/grocery-list/[id].tsx#L67) (fallback only — real path uses [lib/api/grocery.ts:getGroceryList](../../kiwi/lib/api/grocery.ts) at line 152) | Real fetch already wired; this stub branch is for `demo-grocery-*` legacy IDs only — can delete after demo IDs purged | N/A |

---

## §C — AppContext inventory

`AppState` interface declared at [AppContext.tsx:61-194](../../kiwi/contexts/AppContext.tsx#L61-L194); provider at [AppContext.tsx:198-622](../../kiwi/contexts/AppContext.tsx#L198-L622). All mutator stubs are inline at the line numbers below.

| Field | Current backing | Target backing (WS7) | Mutator stub site |
|---|---|---|---|
| `ready` (62) | Boolean from `useEffect` bootstrap | LOCAL_ONLY | n/a |
| `prefs` (63) — legacy `UserPrefs` shape, parallel to `UserPreferencesData` | ASYNC_STORAGE (`loadJSON("prefs", DEFAULT_PREFS)`) | REAL_API_WITH_REACT_QUERY_CACHE via GET/PATCH /me/preferences; **OR eliminate** in favor of `updateUserPreferences/getCurrentUserPreferences` if the two are duplicative (likely yes — legacy field) | [setPrefs at 261](../../kiwi/contexts/AppContext.tsx#L261) (just writes AsyncStorage) |
| `plans` (65) — legacy `MealPlan[]` shape | ASYNC_STORAGE + `defaultPlan()` seed | REAL_API_WITH_REACT_QUERY_CACHE via GET /plans; **legacy `MealPlan` shape should be eliminated** in favor of `ReviewPlan` (WS5+) — these two coexist confusingly | [savePlan at 275](../../kiwi/contexts/AppContext.tsx#L275) (AsyncStorage), [setCurrentPlan at 289](../../kiwi/contexts/AppContext.tsx#L289) |
| `currentPlanId` (66) | ASYNC_STORAGE | REAL_API_WITH_REACT_QUERY_CACHE (active plan resolver) | [setCurrentPlan at 289](../../kiwi/contexts/AppContext.tsx#L289) |
| `currentPlan` (derived from above) | LOCAL_DERIVED | LOCAL_DERIVED on top of real plans | n/a |
| `swapMealInCurrentPlan` (70) | In-memory + AsyncStorage on legacy `MealPlan` shape | ELIMINATE (the WS5+ `changeMealForPlanItem` is the real path; this is duplicative legacy) | [swapMealInCurrentPlan at 299](../../kiwi/contexts/AppContext.tsx#L299) |
| `assignDayToPlanItem` (78) | STUB_IN_MEMORY (`console.log`) | REAL_API → `PATCH /plans/:id/items/:itemId` | [322](../../kiwi/contexts/AppContext.tsx#L322) |
| `unassignDayFromPlanItem` (84) | STUB_IN_MEMORY | REAL_API → same endpoint | [331](../../kiwi/contexts/AppContext.tsx#L331) |
| `addMealToPlan` (89) | STUB_IN_MEMORY | REAL_API → `POST /plans/:id/items` | [339](../../kiwi/contexts/AppContext.tsx#L339) |
| `removeMealFromPlan` (95) | STUB_IN_MEMORY | REAL_API → `DELETE /plans/:id/items/:itemId` | [348](../../kiwi/contexts/AppContext.tsx#L348) |
| `changeMealForPlanItem` (100) | STUB_IN_MEMORY | REAL_API → `PATCH /plans/:id/items/:itemId` { mealId } | [356](../../kiwi/contexts/AppContext.tsx#L356) |
| `changeRecipeForPlanItem` (106) | STUB_IN_MEMORY | REAL_API → `PATCH /plans/:id/items/:itemId` { recipeOverrideJson } | [365](../../kiwi/contexts/AppContext.tsx#L365) |
| `promoteRecipeOverrideToMeal` (112) | STUB_IN_MEMORY | REAL_API → `POST /plans/:id/items/:itemId/promote-override` | [374](../../kiwi/contexts/AppContext.tsx#L374) |
| `findSimilarMeals` (117) | STUB_IN_MEMORY (returns `[]`, `console.log` only) | **ELIMINATE** — duplicate of the React Query hook [useFindSimilarMeals](../../kiwi/hooks/useFindSimilarMeals.ts) already wired to the real endpoint. AppContext entry is dead code. | [382](../../kiwi/contexts/AppContext.tsx#L382) |
| `updatePlanName` (118) | Calls stub mutator on in-memory cache | REAL_API → `PATCH /plans/:id` { name } | [390](../../kiwi/contexts/AppContext.tsx#L390) |
| `updatePlanDateRange` (120) | Calls stub mutator on in-memory cache | REAL_API → `PATCH /plans/:id` { startDate, endDate } | [399](../../kiwi/contexts/AppContext.tsx#L399) |
| `saveDish` (126) | STUB_IN_MEMORY (`console.log`; returns synthetic `dish-${Date.now()}`) | REAL_API → `POST /me/dishes` / `PATCH /me/dishes/:id` | [409](../../kiwi/contexts/AppContext.tsx#L409) |
| `updateUserName` (129) | STUB_IN_MEMORY | REAL_API → `PATCH /me` { firstName, lastName } | [416](../../kiwi/contexts/AppContext.tsx#L416) |
| `updateUserEmail` (131) | STUB_IN_MEMORY | REAL_API → verification flow → `PATCH /me` { email } after confirm | [421](../../kiwi/contexts/AppContext.tsx#L421) |
| `updateUserPhone` (135) | STUB_IN_MEMORY | REAL_API → `PATCH /me` { phone } | [426](../../kiwi/contexts/AppContext.tsx#L426) |
| `updateUserPreferences` (137) | STUB_IN_MEMORY | REAL_API → `PATCH /me/preferences` | [431](../../kiwi/contexts/AppContext.tsx#L431) |
| `deactivateAccount` (140) | STUB_IN_MEMORY | REAL_API → `POST /me/deactivate` (6-month soft-delete) | [438](../../kiwi/contexts/AppContext.tsx#L438) |
| `groceries` (142) — legacy `GroceryItem[]` shape, parallel to grocery list system | ASYNC_STORAGE | ELIMINATE — superseded by GroceryList endpoints | derived in [persistGroceriesFor at 266](../../kiwi/contexts/AppContext.tsx#L266) |
| `toggleGrocery` (143) | LOCAL_ONLY (legacy) | ELIMINATE | [443](../../kiwi/contexts/AppContext.tsx#L443) |
| `toggleGroceryItemCompleted` (146) | STUB_IN_MEMORY | REAL_API → `PATCH /grocery-lists/:id/items/:itemId` { isChecked } | [455](../../kiwi/contexts/AppContext.tsx#L455) |
| `toggleGroceryStapleSelection` (151) | STUB_IN_MEMORY | REAL_API → same endpoint, { isUniversalStaple } | [463](../../kiwi/contexts/AppContext.tsx#L463) |
| `addGroceryItem` (159) | **REAL_API** → wired to `POST /grocery-lists/:id/items` | (already done in 6c-6 Block C) | [474](../../kiwi/contexts/AppContext.tsx#L474) |
| `removeGroceryItem` (164) | STUB_IN_MEMORY | REAL_API → `DELETE /grocery-lists/:id/items/:itemId` | [483](../../kiwi/contexts/AppContext.tsx#L483) |
| `markGroceryShoppingDone` (166) | STUB_IN_MEMORY | REAL_API → `PATCH /grocery-lists/:id` { status } | [491](../../kiwi/contexts/AppContext.tsx#L491) |
| `favorites` (167) | ASYNC_STORAGE | LOCAL_ONLY (mobile-only UX) or NEW `Favorite` model — open product decision | [toggleFavorite at 499](../../kiwi/contexts/AppContext.tsx#L499) |
| `isPremium` (170) | ASYNC_STORAGE | ELIMINATE — derive from `user.subscription.status` (already in `useAuth()`) | [setPremium at 516](../../kiwi/contexts/AppContext.tsx#L516) |
| `onboardingComplete` (172) | ASYNC_STORAGE | REAL_API → `User.onboardingComplete` field (D-WS5-024 — schema migration pending) | [setOnboardingComplete at 521](../../kiwi/contexts/AppContext.tsx#L521) |
| `onboardingStep2Draft` (180), `onboardingStep3Draft` (183) | STUB_IN_MEMORY (transient, lost on unmount) | LOCAL_ONLY (transient) OR REAL_API if Hans wants resume-on-relaunch | [212-220](../../kiwi/contexts/AppContext.tsx#L212-L220) |
| `injectDevTestPlan` (191), `resetAllDevState` (193) | DEV ONLY | DELETE at WS7-CLOSE (already documented) | [530, 554](../../kiwi/contexts/AppContext.tsx#L530-L554) |

---

## §D — Mobile API client state

1. **Top-level fetch wrapper for JWT?** No central wrapper. Each per-feature module ([lib/api/wizard.ts](../../kiwi/lib/api/wizard.ts), [tellKiwi.ts](../../kiwi/lib/api/tellKiwi.ts), [meals.ts](../../kiwi/lib/api/meals.ts), [recipeImport.ts](../../kiwi/lib/api/recipeImport.ts), [grocery.ts](../../kiwi/lib/api/grocery.ts)) repeats the same pattern: `const token = await readToken(); if (!token) throw new Error("Not authenticated"); const res = await fetch(url, { method, headers: { ..., Authorization: 'Bearer ${token}' }, body: JSON.stringify(input) });`. The duplication is 5× and growing — a candidate for early WS7 consolidation. `readToken()` lives at [lib/auth.ts:14](../../kiwi/lib/auth.ts#L14) (backed by `expo-secure-store`).

2. **React Query provider:** Mounted at [app/_layout.tsx:23,73](../../kiwi/app/_layout.tsx#L23-L73) (`new QueryClient()`, `QueryClientProvider`). Consumed today by exactly **three hooks**: `useBuildWizardPlans`, `useBuildFromText`, `useFindSimilarMeals` — all `useMutation`, no `useQuery`. No screen uses React Query for read-side caching today; all reads are ad-hoc `useState` + `useEffect` patterns.

3. **Typed client layer:** Per-endpoint typed wrappers exist at `lib/api/*.ts` for wizard, tellKiwi, meals, recipeImport, grocery. Inline `fetch` survives in `lib/auth.ts` (auth ops) and `lib/api.ts` (`scaleIngredients`). No central response-validation (e.g., Zod parse on the mobile side); the wrappers `as`-cast wire shapes. Acceptable today since the server returns validated shapes, but a centralized wrapper could surface schema drift earlier.

4. **API base URL:** Resolved at the top of every per-feature module (5 duplicate definitions): `process.env.EXPO_PUBLIC_API_BASE_URL || (process.env.EXPO_PUBLIC_DOMAIN ? "https://${EXPO_PUBLIC_DOMAIN}/api" : "http://localhost:3000/api")`. `lib/auth.ts:24` has its own simpler variant (no `EXPO_PUBLIC_DOMAIN` branch) — minor drift; comment at [lib/auth.ts:21](../../kiwi/lib/auth.ts#L21) already calls out "consolidate in WS7."

5. **Error-handling pattern for 401 / 402 / 5xx:** Per-feature modules each handle their own status branches in idiomatic ways:
   - `lib/api/wizard.ts:39-50`: any non-OK throws `Error(body.error ?? "HTTP ${status}")` — surfaces server's Kiwi-styled message
   - `lib/api/grocery.ts:38-105`: discriminated union return (`{ success: true, ...} | { success: false, error: 'list_exists' | 'plan_not_found' | 'ai_failed' | 'unauthenticated' | 'unknown' }`)
   - `lib/api/recipeImport.ts:412-466`: similar discriminated-union return with `{ success: false, reason, userFacingMessage }`
   - 401 handling globally: no central interceptor to clear token + bounce to login. [AuthContext.tsx:61-75](../../kiwi/contexts/AuthContext.tsx#L61-L75) only handles bootstrap-time 401. **WS7 should add a "clear token on 401, surface login modal" interceptor** to keep stale-token UX clean.
   - 402 (entitlement): wizard surfaces the server's `error` message as-is; no upgrade-CTA routing yet.

6. **Loading-state pattern:** Per-screen ad hoc. The three React Query hooks expose `isPending/isError/isSuccess`; everything else uses `useState<boolean>(false)` + `setLoading(true)`. No skeleton-loader convention, no spinner component, no aborted-fetch handling for navigated-away screens.

---

## §E — Stub-alert / stub-banner sites

Material `Alert.alert("Coming in WS7", …)` + `console.log` stub sites surfaced by grep (file:line — description of the surface):

- **[deactivate-account.tsx:52](../../kiwi/app/deactivate-account.tsx#L52)** — Final deactivate-account confirmation Alert ("Coming in WS7 — real deactivation"). User signs out as fallback.
- **[dish-builder.tsx:303](../../kiwi/app/dish-builder.tsx#L303)** — Save dish Alert ("Coming in WS7 — saving new dishes" / "saving dish edits").
- **[dish/[id].tsx:88](../../kiwi/app/dish/[id].tsx#L88)** — Soft-delete Alert ("Coming in WS7", "Soft-deleting dishes requires the API client.").
- **[meal-builder.tsx:464](../../kiwi/app/meal-builder.tsx#L464)** — Save plan-instance override Alert ("Coming in WS7", "Saving plan-instance overrides requires the API client.").
- **[meal-builder.tsx:477](../../kiwi/app/meal-builder.tsx#L477)** — Save globally Alert ("Coming in WS7", "Saving meals globally…").
- **[meal-builder.tsx:487-498](../../kiwi/app/meal-builder.tsx#L487-L498)** — Save imported recipe + save-meal Alerts ("Coming in WS7" — covers D-WS6-088 surface).
- **[meal-builder.tsx:578](../../kiwi/app/meal-builder.tsx#L578)** — Mode A "Tell Kiwi what you want" card Alert (D-WS6-032). Server endpoint `POST /builder/parse-meal` exists and is smoke-passed; mobile not wired.
- **[plan/[id].tsx:357,682](../../kiwi/app/plan/[id].tsx#L357)** — Plan Review banner-ish Alerts (need to inspect specifics; likely linked to the same in-memory mutator stubs).
- **[(tabs)/groceries.tsx:60](../../kiwi/app/(tabs)/groceries.tsx#L60)** — "Get List ✓" CTA Alert ("Coming in WS6 — list generation"). Server endpoint **is** wired (per §A); the tab uses the legacy stub-only `getGroceryLists()` instead of routing through the wired generation flow on plan detail.
- **[(tabs)/groceries.tsx:67](../../kiwi/app/(tabs)/groceries.tsx#L67)** — "Order Online" CTA Alert ("Coming in WS6 — retailer integration"). Per kiwi_ws6_plan.md §7, retailers are deferred indefinitely → WS8 / post-Instacart access. **Keep the stub for WS7 but rename the copy** ("Coming with retailer integration") so user doesn't expect it imminently.
- **[(tabs)/groceries.tsx:74](../../kiwi/app/(tabs)/groceries.tsx#L74)** — "Reuse" past-list CTA Alert ("Coming in WS7 — list reuse").
- **[(tabs)/meals.tsx:181,198](../../kiwi/app/(tabs)/meals.tsx#L181-L198)** — Need to confirm specific surfaces; likely related to list reads from `getSavedMeals()` stub.
- **[(tabs)/profile.tsx:103,121,142,149](../../kiwi/app/(tabs)/profile.tsx#L103-L149)** — Multiple account-mutation flows (change password, etc.) — Alerts.
- **[preferences.tsx:71](../../kiwi/app/preferences.tsx#L71)** — Save preferences Alert (fires after `updateUserPreferences` stub).
- **[manage-account.tsx:19](../../kiwi/app/manage-account.tsx#L19)** — Subscription portal Alert.
- **[meal/[id].tsx:111,147,165,202](../../kiwi/app/meal/[id].tsx#L111-L202)** — Multiple meal-detail action Alerts (need inspection).
- **[grocery-list/[id].tsx:413,459,466,473](../../kiwi/app/grocery-list/[id].tsx#L413-L473)** — Item interaction Alerts (likely tied to `removeGroceryItem`, `markGroceryShoppingDone`, etc. stubs).
- **[tellkiwi.tsx:95](../../kiwi/app/tellkiwi.tsx#L95)** — Unclear-scenario fallback Alert.
- **[components/PlanCardSmall.tsx:26-32](../../kiwi/components/PlanCardSmall.tsx#L26-L32)** — Two Alerts ("Plan preview will land in WS7", "Plan instance creation will land in WS7").
- **[components/PlanRow.tsx:24](../../kiwi/components/PlanRow.tsx#L24)** — Plan-row Open Alert ("Plan detail will land in WS7").
- **[cook-now.tsx](../../kiwi/app/cook-now.tsx)** — Entire page is a "Coming soon" placeholder (text reads "lands in WS6 (AI orchestration)" but WS6 closed without it; **server route is also missing**).
- **[prep-cook.tsx](../../kiwi/app/prep-cook.tsx)** — Entire page is a "Coming with Prep & Cook Hub" placeholder. Server endpoints (cooking-sequence + prep-week) **are** wired and smoke-passed; mobile screen never built (D-WS6-089).

**`TODO(WS7)` markers** (clean to-do list for swap-out): grep returns 17 in AppContext.tsx (each plan/grocery mutator stub), 2 in stubs.ts (`getReviewPlan`, `getMealById`), 1 each in [grocery-list/[id].tsx:312](../../kiwi/app/grocery-list/[id].tsx#L312), [dish-builder.tsx](../../kiwi/app/dish-builder.tsx).

---

## §F — Mobile screen-by-screen gap

| Screen | Data sources today | Gap | WS7 wiring |
|---|---|---|---|
| [app/(tabs)/index.tsx](../../kiwi/app/(tabs)/index.tsx) (Today / Home) | Hero card calls `getTodaysMeal()` + `getCurrentActivePlan()` + `getUserPlans()` from stubs.ts (all return `null`/`[]`). `PlanDiscoveryCard` calls `getHomePayload()` stub. User name + premium gating come from `useAuth()` (real). | Hero card always renders empty state; Plan Discovery empty. | New composite `GET /home` (or compose from `GET /plans` + `GET /plans/today`) + featured/top-rated/hosting payload. |
| [app/(tabs)/plans.tsx](../../kiwi/app/(tabs)/plans.tsx) | `getPlansPayload()` → `[]` | Empty Plans tab. | `GET /plans?filter=my_plans/featured/top_rated/hosting_events` |
| [app/(tabs)/meals.tsx](../../kiwi/app/(tabs)/meals.tsx) (Recipes / Meals) | `getMealsPayload()` → `[]` + `getSavedDishes()` etc fixtures (per imports at line 16-36) | Empty My Meals. | `GET /me/meals` + `GET /me/dishes` + featured/top-rated catalog endpoints. |
| [app/(tabs)/groceries.tsx](../../kiwi/app/(tabs)/groceries.tsx) | `getGroceryLists()` → fixture data | List shows fixtures (not real plans' lists). | `GET /grocery-lists` (NEW). |
| [app/(tabs)/profile.tsx](../../kiwi/app/(tabs)/profile.tsx) | `getCurrentSubscription()` + `getCurrentUserInfo()` fixtures; `updateUserName/Email/Phone` from AppContext (stubs). | Name/email/phone edits go to `console.log`. | Refactor to consume `useAuth().user` (already populated); wire mutators to `PATCH /me` (NEW). |
| [app/wizard.tsx](../../kiwi/app/wizard.tsx) | Reads `getCurrentUserPreferences()` stub to seed form; posts via `router.push` to wizard-results with stringified input. **No persistence — preferences edits in wizard are session-only.** | Form prepop is wrong (fixture data instead of user's saved prefs). | `GET /me/preferences` for seed; `PATCH /me/preferences` on submit (or accept the wizard as "submit-only — no edit-prefs side effect"). |
| [app/wizard-results.tsx](../../kiwi/app/wizard-results.tsx) | Calls real `useBuildWizardPlans` (WIRED) OR consumes preloaded `tellKiwiResult` (from tellkiwi.tsx). `handleUsePlan` at L156 just navigates to `/plan/[id]?id=demo-plan-just-created` — **no save commit** (D-WS6-027). | Candidates render real AI data, but "Use this plan" doesn't persist. | (D-WS6-027) Two-step: expand candidate → render review → save. New `POST /wizard/candidates/:id/expand` + `POST /plans` from expanded payload. |
| [app/tellkiwi.tsx](../../kiwi/app/tellkiwi.tsx) | Real `useBuildFromText` → push to wizard-results with payload | Same save-commit gap as wizard. | Shared with wizard above. |
| [app/cook-now.tsx](../../kiwi/app/cook-now.tsx) | Static "Coming soon" page. | **Server route AND mobile screen both missing.** Despite `wizard.cook_now.generate` prompt seeded, no `POST /wizard/build-cook-now` handler exists; no mobile form for "what's in your kitchen." | New server route (similar to build-from-text) + new mobile screen with pantry-input form. |
| [app/plan/[id].tsx](../../kiwi/app/plan/[id].tsx) (Plan Review) | `getReviewPlan(planId)` (stub branches for `demo` / `demo-plan-just-created`); `getMealById` for meal detail expansion; **`generateGroceryListForPlan` IS WIRED** (L257) | Plan body always empty for real plans; macros static. | `GET /plans/:id` composite endpoint; consume `POST /plans/:id/recalc-macros` (already exists). Plus all 12 mutation callbacks (assign day, swap, override, rename, etc.) — all `console.log` stubs in AppContext today. |
| [app/grocery-list/[id].tsx](../../kiwi/app/grocery-list/[id].tsx) | Real `getGroceryList(id)` from lib/api/grocery (WIRED for new IDs); fixture branch for `demo-grocery-*`. Typeahead via real `lookupGroceryItemCandidates`. Item add via wired `addGroceryItem`. | Item edit/delete/check-off + "shopping done" still stub-only. | `PATCH /grocery-lists/:id/items/:itemId` + `DELETE` + `PATCH /grocery-lists/:id` { status }. |
| [app/import-url.tsx](../../kiwi/app/import-url.tsx), [import-image.tsx](../../kiwi/app/import-image.tsx), [import-text.tsx](../../kiwi/app/import-text.tsx) | All three call real `importRecipeFromXxx` helpers (WIRED). | Save step missing (D-WS6-088): canonical recipe returns to mobile but cannot be persisted into Meal + Dish + RecipeInstructionStep. | New `POST /me/recipes/save-canonical` endpoint that consumes the wire shape and creates Meal/Dish/MealDishLink/per-dish RecipeInstructionStep with `ownerType:"dish"`. Plus failure-mode copy distinction (D-WS6-052) — currently all failures show generic Kiwi text. |
| [app/meal-builder.tsx](../../kiwi/app/meal-builder.tsx) | Mode-picker UI with 3 modes (manual/combine/ai). Mode A locked stub Alert. Other modes navigate to manual editor but save fires `Alert.alert("Coming in WS7", "Saving meals…")`. | Mode A unwired (D-WS6-032); Save unwired; Kiwi-assist not present on Mode B (D-WS6-031 parity gap). | Wire Mode A → `POST /builder/parse-meal`; wire save → `POST /me/meals` (NEW); add Kiwi-assist checkboxes per-dish in Mode B. |
| [app/dish-builder.tsx](../../kiwi/app/dish-builder.tsx) | Kiwi-assist checkboxes present but onChange flips local state only (D-WS6-031). Save calls `saveDish` AppContext stub. | Both Kiwi-assist + save unwired. | Wire checkbox onChange → `POST /builder/assist-ingredients` and `POST /builder/assist-steps`; wire save → `POST /me/dishes` (NEW); drop misleading `Premium · WS6` pill. |
| [app/meal/[id].tsx](../../kiwi/app/meal/[id].tsx) | `getMealById` stub | Detail page shows demo data only. Servings stepper likely calls `scaleIngredients` (WIRED) but on stub data. | `GET /meals/:id` (already exists — repoint mobile). |
| [app/dish/[id].tsx](../../kiwi/app/dish/[id].tsx) | `getSavedDishes/getFeaturedDishes/getTopRatedDishes` fixtures | Detail page on fixtures; soft-delete Alert. | `GET /dishes/:id` (NEW) + `DELETE /me/dishes/:id` (NEW). |
| [app/prep-cook.tsx](../../kiwi/app/prep-cook.tsx) | Static placeholder | Server endpoints `cooking-sequence` + `prep-week` are smoke-passed; mobile never built. | Replace placeholder with two-tab Hub: **Cook Mode** (calls `POST /meals/:mealId/cooking-sequence`, renders sequenced steps) + **Prep the Week** (calls `POST /plans/:planId/prep-week`, renders 4-phase structure with checkbox state). |
| [app/upgrade.tsx](../../kiwi/app/upgrade.tsx) | Static "Coming in WS6 — Stripe" page | Stripe deferred to WS-Stripe phase (post-Instacart). WS7 stays as-is OR polish copy. | OUT-OF-SCOPE for WS7. (D-WS3-019 / D-WS4-002 polish lives in WS9.) |
| [app/preferences.tsx](../../kiwi/app/preferences.tsx) | Seed from `getCurrentUserPreferences` stub; save via AppContext stub. | Form prepop wrong; save no-op. | `GET /me/preferences` for seed; `PATCH /me/preferences` on save. |
| [app/manage-account.tsx](../../kiwi/app/manage-account.tsx) | Subscription fixture; subscription-management Alert. | Subscription mgmt = Stripe = out-of-scope. Account info refactor only. | Refactor subscription read to `useAuth().user.subscription`. |
| [app/deactivate-account.tsx](../../kiwi/app/deactivate-account.tsx) | Calls `deactivateAccount` AppContext stub; on success Alerts + logs out. | No real soft-delete + Stripe cancel. | `POST /me/deactivate` (NEW, 6-month soft-delete semantics). |
| [app/onboarding-prefs.tsx](../../kiwi/app/onboarding-prefs.tsx) (Step 2) | Reads/writes `onboardingStep2Draft` from AppContext (transient, lost on unmount) | Drafts not persisted to backend. | Either keep LOCAL_ONLY (acceptable — drafts are transient) or persist to user record. **D-WS5-024**: `User.onboardingComplete` schema field missing entirely. |
| [app/onboarding-step-3.tsx](../../kiwi/app/onboarding-step-3.tsx) | Same as above + `getCurrentUserPreferences` for seed | Same | Same |

---

## §G — Schema gap check

Tested against [artifacts/api-server/prisma/schema.prisma](../prisma/schema.prisma):

- ✅ `User.phone String?` — **EXISTS** at [schema.prisma:174](../prisma/schema.prisma#L174). (D-WS5-020 already landed.)
- ❌ `User.onboardingComplete Boolean @default(false)` — **MISSING**. (D-WS5-024 still pending.)
- ✅ `User.marketingConsentEmail / marketingConsentSms` — **EXIST** at [schema.prisma:189-190](../prisma/schema.prisma#L189-L190). (Landed in 6a-2.)
- ✅ `Dish.servingsDefault Int @default(4)` — **EXISTS** at [schema.prisma:286](../prisma/schema.prisma#L286). Same for `Meal.servingsDefault` at [schema.prisma:332](../prisma/schema.prisma#L332). (D-WS5-021 already landed for the canonical field; "SavedDish" variant naming was a UX label, not a schema concern.)
- ❌ **`MealPlanInstance` draft-lifecycle state field** — `status` is the `PlanStatus` enum at [schema.prisma:427](../prisma/schema.prisma#L427) (`this_week | next_week | upcoming | past | draft`). The `draft` enum value exists. **No explicit "wizard-pending-expansion" intermediate state**. D-WS6-027 may need a new state like `pending_expansion` or `unsaved_candidate` between candidate selection and Plan Review save, or the expansion can be ephemeral (server-held only) until Save.
- ✅ `MealPlanInstance.revisionId Int @default(1)` — **EXISTS** at [schema.prisma:436](../prisma/schema.prisma#L436). Per D-WS6-091, plan-mutation endpoints (WS7) MUST bump this on every content mutation so `GroceryList.lastGeneratedFromPlanRevisionId` drift detection works.
- ✅ `GroceryListItem.isAmbiguous`, `ambiguityOptions`, `userResolvedTo` — **EXIST** at [schema.prisma:504-511](../prisma/schema.prisma#L504-L511).
- ✅ `PrepWeekStructure` cache table — **EXISTS** at [schema.prisma:528](../prisma/schema.prisma#L528) with `lastGeneratedFromPlanRevisionId` field.
- ⚠️ **`RecipeInstructionStep.parallelGroup`** — Type is `String?` at [schema.prisma:378](../prisma/schema.prisma#L378). See §H drift item 2 — this disagrees with two mealBuilder.ts schemas.
- ⚠️ **No `Favorite` table**. AppContext `favorites: string[]` is AsyncStorage-only. Open product decision whether favorites are local UX state or backend-persisted. (Not blocking — can stay local for WS7.)
- ⚠️ **No `RecipeOverride` table for plan-item overrides**. Today `MealPlanItem.ingredientOverrides Json?` + `MealPlanItem.recipeOverrideJson Json?` are JSON blobs at [schema.prisma:457-458](../prisma/schema.prisma#L457-L458). Adequate for WS7 (matches D-WS6-003 stub at meals.ts:74 expectation); no migration needed.

---

## §H — Pre-WS7 reconciliation drift checks

### 1. D-WS6-029 — recalc-macros response shape ↔ mobile `MacroDailyAverage`

**STILL PRESENT.** Server side: [planMacros.ts:70](../src/lib/planMacros.ts#L70) returns `dailyAverages: { calories, proteinG, carbsG, fatG }`. Mobile side: [lib/types.ts:189](../../kiwi/lib/types.ts#L189) `MacroDailyAverage` has `{ caloriesPerDay, proteinGPerDay, carbsGPerDay, fatGPerDay }`; consumed by `ReviewPlan.macroDailyAverage` ([types.ts:272](../../kiwi/lib/types.ts#L272)).

Reconciliation options:
- (a) Rename server response to `{ caloriesPerDay, proteinGPerDay, carbsGPerDay, fatGPerDay }` — touches `MacroTotals` type in [planMacros.ts:42-50](../src/lib/planMacros.ts#L42-L50), all internal references, plus test fixtures.
- (b) Translate at the mobile API client boundary (`lib/api/plans.ts` — would be new for WS7).

**Recommendation (Claude's judgment, defer to chat-Claude):** option (a). The mobile field names are PRD-aligned ("per day" suffix matches the daily-average framing throughout PRD §11); the server's bare `calories/proteinG` matches per-meal `MacroTotals` better. A single rename plus a separate `DailyMacros` type avoids the translation layer.

### 2. D-WS6-034 — `parallelGroup` type

**STILL PRESENT** in two schemas; resolved in three others.

- Prisma `RecipeInstructionStep.parallelGroup: String?` ([schema.prisma:378](../prisma/schema.prisma#L378)) — canonical
- [cookNow.ts:36](../src/lib/ai/schemas/cookNow.ts#L36): `z.string().optional()` ✓ aligns
- [sequencer.ts:27](../src/lib/ai/schemas/sequencer.ts#L27): `z.string().nullable()` ✓ aligns
- [reformat.ts:135](../src/lib/ai/schemas/reformat.ts#L135): `z.string().nullable().optional()` ✓ aligns
- **[mealBuilder.ts:99](../src/lib/ai/schemas/mealBuilder.ts#L99)** (`AssistedStep`): `z.number().int().positive().max(20).optional()` ✗
- **[mealBuilder.ts:166](../src/lib/ai/schemas/mealBuilder.ts#L166)** (`ParsedSubDishStep`): `z.number().int().positive().max(20).nullable().optional()` ✗

If mealBuilder.ts outputs persist into `RecipeInstructionStep` rows during a save-canonical flow (D-WS6-088), Prisma will reject the int. Fix is to align both `mealBuilder.ts` schemas to `z.string().nullable().optional()` and update prompt body wording (currently the prompt instructs the AI to emit integers like `1`, `2`; needs to instruct strings like `"group-1"` or `"passive-1"` per sequencer.ts convention) — or alternatively change Prisma to `Int?` and reconcile the three string-using schemas in the opposite direction. **String wins by 3-to-2 and matches the more-trafficked Sequencer/Reformat paths.**

### 3. D-WS6-036 — cuisine-case drift

**STILL PRESENT.** [reformat.ts:43-44](../src/lib/ai/schemas/reformat.ts#L43-L44) defines `CuisineTypeEnum` as title-case `z.enum(CUISINE_TYPES)` covering 24 canonical cuisines + "Other"; consumed by `CanonicalMealMeta.cuisineType` at [reformat.ts:155](../src/lib/ai/schemas/reformat.ts#L155). `mealBuilder.ts:24,74,183` uses unconstrained `z.string().max(80).optional()` for cuisine — no enum, no case enforcement. AI outputs from mealBuilder may produce `"italian"` lowercase or `"Italian"` title-case unpredictably.

Recommendation: align `mealBuilder.ts` cuisine fields to `CuisineTypeEnum` (export from reformat.ts or hoist into a shared `cuisine.ts`) so save-canonical persistence has one cuisine vocabulary.

---

## §I — End-to-end user flow status

| # | Flow | Status | Notes |
|---|---|---|---|
| 1 | Sign up → onboarding 2 → 3 → home with content | BLOCKED_BY_MISSING_ENDPOINT | Auth wired; onboarding drafts transient (no `onboardingComplete` field per D-WS5-024); home stub returns `[]` |
| 2 | Home → Set Prefs Wizard → candidates → save plan → Plan Review | BLOCKED_BY_MISSING_ENDPOINT | Candidates wired; "Use this plan" jumps to stub plan ID; no `POST /plans` (D-WS6-027) |
| 3 | Home → Tell Kiwi → candidates → save plan → Plan Review | BLOCKED_BY_MISSING_ENDPOINT | Same blocker as #2 |
| 4 | Home → Cook What I Have Now → candidate → save / cook | BLOCKED_BY_MISSING_ENDPOINT | Both server route and mobile screen missing |
| 5 | Plan Review → swap a meal → save change | BLOCKED_BY_MISSING_ENDPOINT | `changeMealForPlanItem` stub + `PATCH /plans/:id/items/:itemId` missing |
| 6 | Plan Review → edit dish (servings/ingredient override) → save | BLOCKED_BY_MISSING_ENDPOINT | Same |
| 7 | Plan Review → tap "Grocery List" → generated | WORKS_END_TO_END (for any real plan that exists) | `generateGroceryListForPlan` wired, smoke-passed |
| 8 | Grocery list → add via typeahead → check off → undo | BLOCKED_BY_STUB (check-off + undo); add WIRED_REAL | Real lookup + add; check-off/edit/delete stubs |
| 9 | Grocery list → 2nd plan exists → multi-plan picker | BLOCKED_BY_STUB | Picker stub exists per WS5-5Q-bis comment in tabs/groceries.tsx; needs real plans + real grocery list endpoint |
| 10 | Meal Builder Mode A (free-text) → review → save | BLOCKED_BY_STUB + MISSING | Server `POST /builder/parse-meal` ready; mobile is locked Alert (D-WS6-032); save endpoint missing too |
| 11 | Meal Builder Mode B (manual + Kiwi-assist) → save | BLOCKED_BY_STUB + MISSING | Kiwi-assist checkboxes absent on Mode B (D-WS6-031); save endpoint missing |
| 12 | Dish Builder (manual + Kiwi-assist) → save | BLOCKED_BY_STUB + MISSING | Kiwi-assist no-op (D-WS6-031); save endpoint missing |
| 13 | Recipe Import URL → save → My Recipes | BLOCKED_BY_MISSING_ENDPOINT | Import wired; save-canonical missing (D-WS6-088) |
| 14 | Recipe Import Image → save → My Recipes | BLOCKED_BY_MISSING_ENDPOINT | Same |
| 15 | Recipe Import Text → save → My Recipes | BLOCKED_BY_MISSING_ENDPOINT | Same |
| 16 | Plan Review or My Meals → Find Similar → swap result back | BLOCKED_BY_STUB | Server wired + hook exists; FindSimilarSheet uses cuisine-only stub |
| 17 | Plan Review → Cook Mode (single-dish) → sequenced steps render | BLOCKED_BY_MISSING_ENDPOINT (mobile screen) | Server ready; prep-cook.tsx is placeholder (D-WS6-089) |
| 18 | Plan Review → Cook Mode (multi-dish) → sequenced + reasons | BLOCKED_BY_MISSING_ENDPOINT (mobile screen) | Same |
| 19 | Plan Review → Prep the Week → 4-phase + checkboxes | BLOCKED_BY_MISSING_ENDPOINT (mobile screen) | Server ready (with cache); mobile placeholder (D-WS6-092 optional cache-miss event) |
| 20 | Profile → edit prefs → save → wizard reads updated on remount | BLOCKED_BY_MISSING_ENDPOINT | Both GET + PATCH /me/preferences missing |
| 21 | Profile → edit account info (name, email, phone, password) | BLOCKED_BY_MISSING_ENDPOINT | Only `/me/ui-state` exists; `PATCH /me` for these fields missing |
| 22 | Profile → deactivate → 6-month soft-delete | BLOCKED_BY_MISSING_ENDPOINT | `POST /me/deactivate` missing |

---

## §J — Open product decisions

| Decision | State today | Plan-lock action |
|---|---|---|
| **D-WS6-027** wizard two-step + save commit | DESIGN LOCKED per kiwi_ws6_plan.md §6 entry. Two-step: candidates ship titles only; chosen candidate expands to real ingredients + macros on "Review this plan"; commits on "Save and use this plan". | Confirmed locked. Sub-phase plan can proceed. **One unresolved sub-question**: does the in-flight expanded candidate need to be persisted to DB (resume support), or held server-side in memory (Redis-style) for the session? Worth a 1-line Hans clarification. |
| **D-WS6-046** caveats UI (A/B/C) | OPEN. Surfaces wherever AI returns `caveats[]` (meal-builder review, import review). | Sub-phase that wires save-canonical + meal-builder-review needs Hans's A/B/C pick before drafting copy/UI. |
| **D-WS5-038 case 4** smart grocery list user-requested regen override | OPEN per midpoint chat — UX deferred unless audit surfaces new info. | Audit surfaces no new info. Defer per existing guidance. |
| **D-WS3-018** plan discovery filter multi-select vs single-select | RE-EVAL after real data lands per existing guidance. | Mid-WS7 decision (after `getPlansPayload()` returns real plans). |
| **D-WS4-008** admin/featuring fields wired | OPEN — WS7 alongside `getPlansPayload()` real-data wiring, or WS9? | **Recommend WS7** if the same sub-phase wires `getHomePayload` + `getPlansPayload`. The schema fields (`isFeatured`, `featuredRank`, `featuredStartDate`, `featuredEndDate`, `isHostingFeatured`, `hostingFeaturedRank`, `occasionType` on `MealPlanTemplate` per schema.prisma:404-410) already exist; just need a server endpoint to query + an admin write-path. Admin UI itself is WS9 — but the read path WS7 ships needs to honor these fields. |
| **Favorites** (heart) — local-only vs backend-persisted | Today: AsyncStorage-only `favorites: string[]` | LOW priority. Hans's call whether WS7 promotes to a `Favorite` table or leaves local. |
| **Onboarding draft persistence** | Today: in-memory only, lost on unmount | Open: keep transient or persist to server. Likely keep transient for WS7. |

---

## §K — Proposed sub-phase decomposition (best-guess for chat-Claude)

Drafted to surface the dependency DAG and approximate scope. **Chat-Claude will reshape**. Sub-phases tagged S (≤1 day Claude execution), M (1-3 days), L (3-5 days) based on WS5/WS6 patterns.

**WS7-PRE-FIX** — Reconciliation drift cleanup (must land before mutation endpoints). **Size: S.** Inputs: D-WS6-029, D-WS6-034, D-WS6-036. Deliverables: (1) `MacroTotals` daily-average shape rename in planMacros.ts + tests; (2) `mealBuilder.ts` parallelGroup → string + prompt rewording; (3) mealBuilder.ts cuisine → `CuisineTypeEnum`. No mobile changes. **Dependencies: none.** Predecessor for all later sub-phases.

**WS7-1** — Mobile API client foundation. **Size: M.** Deliverables: (1) central `apiClient(method, path, body, opts)` wrapper that attaches JWT, handles 401 (clear token + bounce), surfaces 402 routing to upgrade; (2) consolidate `apiBase` resolution (kill 6× duplication including lib/auth.ts); (3) refactor existing 5 per-feature modules to use the wrapper; (4) document React Query conventions (mutations exist; add `useQuery` patterns); (5) loading-state convention (component or hook). No new endpoints. **Dependencies: WS7-PRE-FIX.** **Predecessor for everything that adds new fetch calls.**

**WS7-2** — Account + preferences persistence. **Size: M.** Deliverables: server `PATCH /me {name,email,phone,password}`, `POST /me/deactivate`, `GET /me/preferences`, `PATCH /me/preferences`; schema migration for `User.onboardingComplete Boolean @default(false)` (D-WS5-024); mobile wire-up of AppContext stubs `updateUserName/Email/Phone/Preferences/deactivateAccount`; refactor [profile.tsx](../../kiwi/app/(tabs)/profile.tsx) + [preferences.tsx](../../kiwi/app/preferences.tsx) + [deactivate-account.tsx](../../kiwi/app/deactivate-account.tsx) + [onboarding-step-3.tsx](../../kiwi/app/onboarding-step-3.tsx). Email-change verification flow lives here. **Dependencies: WS7-1.** Closes flows #20, #21, #22.

**WS7-3** — Read-side composite payloads. **Size: M.** Deliverables: server `GET /home` (today's meal + active plan + plan discovery), `GET /plans` (list with filter), `GET /plans/:id` (composite Plan Review payload — meta + items + meals + dishes + ingredients + macros), `GET /me/meals`, `GET /me/dishes`, `GET /grocery-lists`, `GET /plans/today`, `GET /plans/current`; mobile wire-up of `getHomePayload/getPlansPayload/getMealsPayload/getReviewPlan/getGroceryLists/getCurrentActivePlan/getTodaysMeal/getUserPlans` stubs (the stub `getMealById` repoints to existing `/recipes/:id` — small adapter). **Dependencies: WS7-1.** Brings Home + tabs to life with real data; Plan Review reads work but mutations still stub.

**WS7-4** — Plan mutation endpoints. **Size: L.** Deliverables: server `POST /plans` (create empty), `PATCH /plans/:id` (rename, dates, status), `DELETE /plans/:id`, `POST /plans/:id/items`, `PATCH /plans/:id/items/:itemId` (mealId, assignedDayOfWeek, servingsOverride, ingredientOverrides, recipeOverrideJson, isBreakfast/Lunch/Dinner), `DELETE /plans/:id/items/:itemId`, `POST /plans/:id/items/:itemId/promote-override`; **every mutation MUST bump `MealPlanInstance.revisionId`** (D-WS6-091); mobile wire-up of the 7 AppContext plan-item mutator stubs (assign/unassign day, add/remove meal, change meal, change recipe, promote override) + `updatePlanName/updatePlanDateRange`. Wire `POST /plans/:id/recalc-macros` (existing endpoint) to fire on plan-item mutations. **Dependencies: WS7-PRE-FIX (D-WS6-029 shape rename), WS7-3 (plan read payload to mutate against).** Closes flows #5, #6.

**WS7-5** — Wizard save commit (two-step expansion). **Size: L.** Deliverables: server `POST /wizard/candidates/expand` (takes a candidate from build-plans/build-from-text response → AI expansion of ingredients + macros → returns expanded shape) + `POST /plans/from-candidate` (creates Meal + Dish + MealPlanInstance + items from an expanded candidate); mobile wire-up of new Plan Review intermediate state ("Review this plan" → expand → render → "Save and use this plan" → commit); **D-WS6-046 caveats UI decision needed first**. **Dependencies: WS7-PRE-FIX, WS7-3, WS7-4. Hans gate: D-WS6-046 A/B/C pick.** Closes flows #2, #3.

**WS7-6** — Save-canonical (recipe import + builder) + Kiwi-assist wiring. **Size: M.** Deliverables: server `POST /me/recipes/save-canonical` (consumes CanonicalRecipe wire shape; creates Meal + Dish + MealDishLink + per-dish RecipeInstructionStep with `ownerType:"dish"`; **depends on D-WS6-034 string parallelGroup landing in WS7-PRE-FIX**); mobile wire-up of save buttons in [meal-builder.tsx](../../kiwi/app/meal-builder.tsx) (Mode A parse + save; Mode B save; combine save) and [dish-builder.tsx](../../kiwi/app/dish-builder.tsx) (save); wire Kiwi-assist checkboxes in dish-builder (D-WS6-031); add Kiwi-assist to meal-builder Mode B per-dish (D-WS6-031 parity); wire Mode A free-text card in meal-builder to `POST /builder/parse-meal` (D-WS6-032); wire save flow at end of all 3 import screens (D-WS6-088); distinguish failure-mode copy (D-WS6-052). **Dependencies: WS7-PRE-FIX, WS7-1.** Closes flows #10, #11, #12, #13, #14, #15.

**WS7-7** — Grocery list mutation wiring + Find Similar swap. **Size: M.** Deliverables: server `PATCH /grocery-lists/:id` { status }, `PATCH /grocery-lists/:id/items/:itemId` (isChecked, quantity, isUniversalStaple), `DELETE /grocery-lists/:id/items/:itemId`, real undo endpoint (D-WS6-081 typeahead + D-WS6-082 undo + D-WS6-080 section override); mobile wire-up of `toggleGroceryItemCompleted/toggleGroceryStapleSelection/removeGroceryItem/markGroceryShoppingDone` AppContext stubs; swap [FindSimilarSheet.tsx:131](../../kiwi/components/FindSimilarSheet.tsx#L131) from cuisine stub to `useFindSimilarMeals` hook (one-line UI change). Also: smart grocery list sync (D-WS5-038 cases 2-4: `PATCH /grocery-lists/:id/sync-with-plan` for plan-changed-since-generation drift). **Dependencies: WS7-3 (plans must exist), WS7-4 (revisionId bumps).** Closes flows #8, #9, #16.

**WS7-8** — Cook Mode + Prep the Week mobile screens. **Size: M.** Deliverables: replace [prep-cook.tsx](../../kiwi/app/prep-cook.tsx) placeholder with a hub routing to two new screens; new [cook-mode.tsx](../../kiwi/app/cook-mode.tsx) (consumes `POST /meals/:mealId/cooking-sequence`, renders sequenced steps with dish attribution + reasons, timing-sensitive markers; D-WS6-087 pre-warm/cache deferred unless needed); new [prep-the-week.tsx](../../kiwi/app/prep-the-week.tsx) (consumes `POST /plans/:planId/prep-week`, renders 4-phase structure with persistent checkbox state per PRD §13.4.4-5; D-WS6-092 optional cache-miss activity event). **Dependencies: WS7-3, WS7-4 (real plans must exist to launch from).** Closes flows #17, #18, #19.

**WS7-9** — Cook What I Have Now. **Size: M.** Deliverables: server `POST /wizard/build-cook-now` route handler (matches Tell Kiwi pattern; binds to seeded `wizard.cook_now.generate` prompt); mobile [cook-now.tsx](../../kiwi/app/cook-now.tsx) form (pantry input, prefs surface, submit → builds candidate → optional save to plan). **Dependencies: WS7-PRE-FIX, WS7-1, WS7-5 (if optional save-to-plan routes through save-commit).** **Could be deferred to a WS7-late or WS9 if scope tight.** Closes flow #4.

**WS7-CLOSE** — Cumulative smoke + dev-scaffold removal. **Size: S.** Deliverables: full mobile smoke of all 22 flows; remove `injectDevTestPlan` / `resetAllDevState` from AppContext + Profile screen; remove `defaultPlan()` / `buildGroceryList()` legacy code paths; delete or radically prune `lib/stubs.ts` (keep only any read-side stubs still useful, e.g. demo-mode); freeze handoff.

**Critical path:** PRE-FIX → WS7-1 → (WS7-2 ‖ WS7-3) → WS7-4 → (WS7-5 ‖ WS7-6 ‖ WS7-7 ‖ WS7-8 ‖ WS7-9) → CLOSE. WS7-2 / -3 parallelizable; WS7-5 through -9 mostly parallelizable after WS7-4.

---

## §L — Out-of-scope confirmation

Confirmed NOT in WS7 based on this audit:

- **Stripe checkout, billing webhooks, Customer Portal** — WS-Stripe phase (deferred per kiwi_ws6_plan.md §7 until Instacart access lands)
- **Retailer integrations** (Instacart Direct API, Whole Foods, Amazon Fresh, etc.) — same deferred phase
- **Admin web UI at kitchenwizard.ai/admin** (PRD §15.3) — WS9; the schema fields exist now (`isFeatured` etc.) and WS7-3 reads them, but write path is WS9
- **Activity dashboard / timeline UI** — defer; activities table is populated by server events but no consumer surface exists or is needed for the end-to-end loop
- **OAuth (Apple Sign-In + Google + Apple Hide-My-Email)** — separate workstream per kiwi_ws6_plan.md §7
- **Source Serif 4 font loading** (D-WS5-026) — pre-launch
- **WS9 polish** — button-icon polish, native date picker, multiline Done button, SDK version bumps, upgrade-screen pricing/copy (D-WS3-019 / D-WS4-002), USDA macro integration (D-WS6-024), "Estimated" badge (D-WS6-025), wizard `estimatedCalories` honesty pass (D-WS6-026)

**Borderline items where WS7 vs WS8 vs WS9 line is fuzzy:**

- **Cook What I Have Now (WS7-9 above):** Required for "full meal-planning loop end-to-end" per WS7 success criterion, but server route doesn't exist and there's no AI-orchestration sub-phase budget in WS7's stated scope. Defaulting to WS7-9 with a "could defer" flag. Hans should weigh in.
- **D-WS6-046 caveats UI:** Spans WS7 (wiring) and WS9 (polish), but the wiring sub-phase (WS7-6) needs Hans's A/B/C pick before it can ship.
- **D-WS6-087 Sequencer pre-warm + cache:** Trigger-pinned to latency complaint; not blocking WS7. Stays deferred until evidence demands it.
- **Subscription `SubscriptionService.can()` against real billing state:** Today a passthrough (allow-all in trial mode). WS7 does NOT need to implement real entitlement evaluation — the entitlement gates are wired and trial-mode behavior is correct for pre-launch testing. WS-Stripe phase wires real billing.
- **Server-side `getMealById` repointing:** Borderline whether the existing `GET /recipes/:id` endpoint is the right shape vs needing a separate `GET /meals/:id`. Probably the existing endpoint is fine after WS7-3 mobile-side adapter work.

---

## §M — New deferrals surfaced during audit

Starting at D-WS7-001 per audit prompt. Format matches existing kiwi_deferred_decisions_log.md entries.

### D-WS7-001 — FindSimilarSheet still uses cuisine-only stub despite real AI endpoint being wired

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [UX] [WS7-WIRING] [LOW-EFFORT]
- **Current state**: Server `POST /meals/find-similar` exists and is smoke-passed ([meals.ts:128](../src/routes/meals.ts#L128)). React Query hook `useFindSimilarMeals` exists at [hooks/useFindSimilarMeals.ts:11](../../kiwi/hooks/useFindSimilarMeals.ts#L11). But [FindSimilarSheet.tsx:131](../../kiwi/components/FindSimilarSheet.tsx#L131) still calls `findSimilarMealsByCuisine` stub from [lib/stubs.ts:2078](../../kiwi/lib/stubs.ts#L2078).
- **Target state**: Swap the FindSimilarSheet consumer to use the hook; keep the cuisine-only function as the documented PRD §8.4 fallback path when AI returns `metadata.mode === "fallback_cuisine"` (or on AI failure).
- **Owner**: WS7-7 (grocery + Find Similar swap).
- **Status**: 🟡 OPEN.

### D-WS7-002 — Cook What I Have Now: server route and mobile screen both missing

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [API] [UX] [SCOPE]
- **Current state**: `wizard.cook_now.generate` prompt key is seeded in WS6 6a-2; Zod schemas exist at [cookNow.ts](../src/lib/ai/schemas/cookNow.ts). No server route binds to the prompt key. Mobile [cook-now.tsx](../../kiwi/app/cook-now.tsx) is a static "Coming soon" page ("lands in WS6 (AI orchestration)" — but WS6 closed without this surface).
- **Target state**: Server `POST /wizard/build-cook-now` route handler (Tell Kiwi pattern: parse pantry input + prefs → run AI → return CookNowResult). Mobile screen with pantry-input form + result render + optional save-to-plan.
- **Owner**: WS7-9 (or defer to WS9 if WS7 scope tightens).
- **Status**: 🟡 OPEN — scope decision needed.

### D-WS7-003 — Central mobile API client wrapper (DRY pass over 5+ duplicated fetch boilerplates)

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [REFACTOR] [DX] [FOUNDATION]
- **Current state**: Each per-feature mobile API module ([lib/api/wizard.ts](../../kiwi/lib/api/wizard.ts), [tellKiwi.ts](../../kiwi/lib/api/tellKiwi.ts), [meals.ts](../../kiwi/lib/api/meals.ts), [recipeImport.ts](../../kiwi/lib/api/recipeImport.ts), [grocery.ts](../../kiwi/lib/api/grocery.ts)) reimplements `apiBase` resolution + `readToken` + `Authorization: Bearer ${token}` header + JSON error parse. [lib/auth.ts:24](../../kiwi/lib/auth.ts#L24) has a 6th, slightly drifted variant of `apiBase`. No 401 → clear-token-and-bounce interceptor. No 402 → upgrade-route helper.
- **Target state**: Single `apiClient(method, path, body, opts)` wrapper with: JWT injection, error envelope handling, 401 cascade (clear token, surface AuthContext-level signal), 402 helper, base-URL consolidation. All 5 per-feature modules refactor to call the wrapper.
- **Owner**: WS7-1 (foundation).
- **Status**: 🟡 OPEN.

### D-WS7-004 — AppContext.findSimilarMeals stub is dead code; remove during cleanup

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [REFACTOR] [DEAD-CODE]
- **Current state**: [AppContext.tsx:117](../../kiwi/contexts/AppContext.tsx#L117) declares `findSimilarMeals: (mealId: string) => Promise<string[]>`; impl at [AppContext.tsx:382](../../kiwi/contexts/AppContext.tsx#L382) `console.log`s and returns `[]`. The React Query hook `useFindSimilarMeals` is the actual real-AI path; AppContext entry is orphaned.
- **Target state**: Drop from AppState interface + provider at WS7-7 close (after FindSimilarSheet swap lands).
- **Owner**: WS7-7 / WS7-CLOSE.
- **Status**: 🟢 LOGGED (mechanical).

### D-WS7-005 — Legacy AppContext fields parallel to WS5+ shapes should be eliminated

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [REFACTOR] [TYPE-DRIFT]
- **Current state**: AppContext maintains two parallel shapes:
  - `prefs: UserPrefs` ([AppContext.tsx:63](../../kiwi/contexts/AppContext.tsx#L63)) vs `UserPreferencesData` (used by Profile + Wizard via stubs)
  - `plans: MealPlan[]` ([AppContext.tsx:65](../../kiwi/contexts/AppContext.tsx#L65)) vs `ReviewPlan` (Plan Review canonical)
  - `groceries: GroceryItem[]` ([AppContext.tsx:142](../../kiwi/contexts/AppContext.tsx#L142)) vs `GroceryList` + items (real grocery system)
  - `isPremium: boolean` ([AppContext.tsx:170](../../kiwi/contexts/AppContext.tsx#L170)) vs `user.subscription.status` from `useAuth()`
- **Target state**: Eliminate the legacy halves; consumers move to the canonical shapes. Some consumers (`swapMealInCurrentPlan`, `toggleGrocery`) can be deleted outright; others (`setPrefs`) wrap the canonical `updateUserPreferences` mutator.
- **Owner**: WS7-CLOSE cleanup sweep.
- **Status**: 🟢 LOGGED.

### D-WS7-006 — No global 401 interceptor; stale-token UX is ad hoc

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [API] [SECURITY] [UX]
- **Current state**: [AuthContext.tsx:61-75](../../kiwi/contexts/AuthContext.tsx#L61-L75) only handles bootstrap-time 401 (clears token silently). Once authenticated, if any wired endpoint returns 401 mid-session (token expiry, server-side revocation, account deactivation in a separate device), per-feature modules surface the 401 as an Error and the user sees an opaque failure with no auto-logout.
- **Target state**: Central wrapper (D-WS7-003) detects 401 → clears token + emits AuthContext signal → root layout routes to login. Optional: refresh-token flow (not in scope unless server adds refresh tokens; today JWT lifetime is the entirety).
- **Owner**: WS7-1 (foundation) — co-located with D-WS7-003.
- **Status**: 🟡 OPEN.

### D-WS7-007 — D-WS6-088 save-canonical also unblocks recipe-import failure-mode copy distinction (D-WS6-052)

- **Source**: WS7-PRE audit (2026-05-18). Cross-link.
- **Tags**: [UX] [WS7-WIRING] [CROSS-REF]
- **Current state**: Three import screens (URL/image/text) all surface generic `userFacingMessage` strings on failure. D-WS6-052 calls for distinct copy per failure mode (e.g., URL parse failed vs fetch rate-limited vs Cloudflare-blocked).
- **Target state**: When WS7-6 wires the save flow, also expand the failure-mode UX in each import screen. Server already returns `reason` discriminator on failure responses ([recipeImport.ts ImportRecipeFromUrlResult](../../kiwi/lib/api/recipeImport.ts)); just needs richer mobile-side copy mapping.
- **Owner**: WS7-6 (alongside save-canonical work).
- **Status**: 🟢 LOGGED (already a D-WS6 deferral; surfacing the cross-link).

### D-WS7-008 — `Recipes` legacy server endpoint vs `/me/meals` new endpoint naming

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [API] [NAMING]
- **Current state**: WS2 shipped `GET /recipes` + `GET /recipes/:id` at [recipes.ts:436,481](../src/routes/recipes.ts#L436-L481) that query the `Meal` table (filtered to public). They use "recipes" in the path despite returning meals. WS7-3 needs `GET /me/meals` (user's own) and probably wants `GET /meals/:id` for detail. Naming collision risk.
- **Target state**: Two clean options:
  - (a) Rename existing endpoints to `/meals` + `/meals/:id` (current "recipes" terminology is misleading) and add `/me/meals` for the user-scoped variant; or
  - (b) Keep "recipes" as a separate read-side alias for the public catalog and add `/me/meals` + `/meals/:id` parallel.
- **Owner**: WS7-3 read-side composite.
- **Status**: 🟡 OPEN — small design decision.

### D-WS7-009 — `tabs/groceries.tsx` "Get List ✓" button copies say "Coming in WS6" despite generation being wired

- **Source**: WS7-PRE audit (2026-05-18).
- **Tags**: [UX] [COPY]
- **Current state**: [tabs/groceries.tsx:60](../../kiwi/app/(tabs)/groceries.tsx#L60) Alert reads "Coming in WS6 — list generation". The endpoint **is** wired via [plan/[id].tsx:257](../../kiwi/app/plan/[id].tsx#L257) `generateGroceryListForPlan`. The button on the Groceries tab is misleading.
- **Target state**: Either route this button into the wired generation flow (requires picking a plan first) OR remove the button (current users generate from Plan Review). WS7-7 fix.
- **Owner**: WS7-7.
- **Status**: 🟢 LOGGED.

### D-WS7-010 — Recipe `parallelGroup` AI prompt rewording when type drifts from int to string

- **Source**: WS7-PRE audit cross-reference to D-WS6-034.
- **Tags**: [AI-PROMPT] [TYPE-DRIFT]
- **Current state**: Resolving D-WS6-034 (mealBuilder.ts parallelGroup int → string) also requires updating the prompt body for `meal_builder.mode_a_parse` and `meal_builder.assist_steps` — today the prompt instructs the AI to output integers like `1`, `2`. The schema validates ints; flipping to string means re-validating the prompt produces strings like `"group-1"` or `"passive-1"` per sequencer convention.
- **Target state**: After WS7-PRE-FIX schema change, re-run mealBuilder smokes with the updated prompt body to confirm AI outputs aren't drifting back to ints.
- **Owner**: WS7-PRE-FIX.
- **Status**: 🟡 OPEN.

### D-WS7-011 — onboardingComplete persistence + redirect gating

- **Source**: WS7-PRE audit cross-reference to D-WS5-024.
- **Tags**: [SCHEMA] [WS7-WIRING] [ROUTING]
- **Current state**: `User.onboardingComplete` field doesn't exist in Prisma schema. AppContext maintains `onboardingComplete: boolean` in AsyncStorage only ([AppContext.tsx:172](../../kiwi/contexts/AppContext.tsx#L172)). Per PRD §3.6, first-time arrival routing depends on this flag.
- **Target state**: Add `User.onboardingComplete Boolean @default(false)` migration; on signup default false; flip to true at end of step-3; consume in root layout to gate routing between (auth) → onboarding → tabs.
- **Owner**: WS7-2 (account + preferences persistence).
- **Status**: 🟡 OPEN.

---

## §N — Surprises and judgment calls

1. **Wizard candidates render real AI but the save commit is genuinely a no-op `router.push`.** [wizard-results.tsx:156-164](../../kiwi/app/wizard-results.tsx#L156-L164) `handleUsePlan` just navigates to `/plan/[id]?id=demo-plan-just-created`. The Plan Review screen then renders the empty `demo-plan-just-created` branch of [stubs.ts:244-261](../../kiwi/lib/stubs.ts#L244-L261). It looks like a working flow but persists nothing. D-WS6-027 already locked the two-step design; flagging here so chat-Claude knows the today-state is "looks fine, does nothing" not "stub Alert."

2. **Cook What I Have Now is a real product gap** with neither server route nor mobile screen, despite being one of three wizard entrances in PRD §7. The codebase even has `wizard.cook_now.generate` prompt key + Zod schemas seeded in WS6 6a-2 — somebody planned for it and the route never landed. If WS7 success criterion is "full meal-planning loop end-to-end," this either needs to be in WS7 scope OR explicitly noted as launch-deferrable.

3. **`getMealById` stub vs `GET /recipes/:id` server endpoint:** The server route exists and returns the right shape (with ingredients flattened from the first dish). Mobile's `getMealById` could repoint with a small adapter — easier win than expected. Same for Plan Review's individual-meal expansion path.

4. **Server-side `GET /recipes/:id` is brittle for multi-dish meals.** [recipes.ts:521-527](../src/routes/recipes.ts#L521-L527) flattens "the first dish's ingredients" — comment says "When meals gain multiple dishes post-WS6, this shape will need rework." WS7 will hit this immediately on save-canonical meals (D-WS6-088) since imported meals can have multiple dishes (sauce + protein + base). Worth a parallel WS7-3 task to fix the read shape for multi-dish meals.

5. **`lib/auth.ts` apiBase differs from `lib/api/*.ts`** — auth.ts ignores `EXPO_PUBLIC_DOMAIN`. If a deploy ever sets `EXPO_PUBLIC_DOMAIN` but not `EXPO_PUBLIC_API_BASE_URL`, auth calls go to localhost while everything else goes to the deploy. **Already commented** at [lib/auth.ts:21](../../kiwi/lib/auth.ts#L21) ("consolidate in WS7") but flagging because this is a footgun if any non-localhost build happens between now and WS7-1 landing.

6. **`isPremium: boolean` in AppContext is duplicative with `useAuth().user.subscription`.** Two sources of truth for the same gate. Some screens read AppContext (`isPremium`); the wizard tile in [tabs/index.tsx:62](../../kiwi/app/(tabs)/index.tsx#L62) reads `useAuth().user.subscription.status` ("trialing" or "active"). They could drift. Mostly mechanical to fix in WS7-CLOSE.

7. **No `useQuery` consumers anywhere in mobile.** React Query is mounted but only used for the 3 mutations. WS7-3 (read-side composite payloads) is a great opportunity to establish the `useQuery` pattern — invalidation, refetch on focus, stale time. Don't ad-hoc the wiring; pick conventions and document them.

8. **`updateUserEmail` stub comment says "TODO(WS6)" not WS7** ([AppContext.tsx:422](../../kiwi/contexts/AppContext.tsx#L422)) — the only WS6 TODO marker I noticed. Email change with verification flow was never landed; WS7-2 picks it up.

9. **`(tabs)/groceries.tsx` is the highest-density "Coming in WS6" misnomer screen** — three stub Alerts that still reference WS6 ("list generation," "retailer integration," and one that correctly says WS7). Worth a copy-pass independent of the wiring work so the screen doesn't lie to early testers.

10. **Smoke-evidence is hard to verify without project-knowledge access.** I marked smoke states based on commit messages + sub-phase close notes visible in `git log` and kiwi_ws6_plan.md, plus the SMOKE_6c-6.md file. Chat-Claude with access to the full deferral log + remediation-progress notes may have more precise smoke statuses than I do — verify before locking each sub-phase.

11. **I did not verify**: (a) whether `useApp().savePlan` is actually consumed by any current code path (it might be dead in legacy `MealPlan` shape); (b) the exact callsites on plan/[id].tsx lines 357,682 — only confirmed they're Alert.alert sites without checking the surface; (c) whether the auth password-reset endpoints have a mobile UI yet (grep returned no calls but I didn't open every screen); (d) `meal/[id].tsx` consumption of `scaleIngredients` end-to-end. Worth a 10-minute targeted pass during WS7-PRE-FIX.

---

**End of audit report.**
