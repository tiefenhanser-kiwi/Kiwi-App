import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { buildDevTestPlan } from "@/lib/dev/devPlanFixture";
import { loadJSON, removeKey, saveJSON } from "@/lib/storage";
import {
  addGroceryListItem,
  updateGroceryListStatus,
  updateGroceryListItem,
  deleteGroceryListItem,
  restoreGroceryListItem,
  type AddItemPayload,
} from "@/lib/api/grocery";
import { buildGroceryList, defaultPlan } from "@/lib/stubs";
import {
  saveDish as saveDishAPI,
  updateDish as updateDishAPI,
  type UpdateDishInput,
  type UpdateDishResponse,
} from "@/lib/api/dishes";
import * as meAPI from "@/lib/api/me";
import {
  saveMeal as saveMealAPI,
  updateMeal as updateMealAPI,
  type SaveMealInput,
  type SaveMealResponse,
  type UpdateMealInput,
  type UpdateMealResponse,
} from "@/lib/api/meals";
import {
  createPlan as createPlanAPI,
  deletePlanItem,
  patchPlan,
  patchPlanItem,
  postPlanItem,
  promoteItemOverride,
  recalcPlanMacros,
  useTemplate as useTemplateAPI,
} from "@/lib/api/plans";
import { useAuth } from "@/contexts/AuthContext";
import type {
  DayOfWeek,
  DishDraft,
  GroceryItem,
  GroceryList,
  GroceryListItem,
  MealPlan,
  RecipeOverride,
  Step2Draft,
  Step3Draft,
  User,
  UserPreferencesData,
} from "@/lib/types";

export interface UserPrefs {
  household: number;
  diet: string[];
  allergies: string[];
  dislikes: string[];
  cuisines: string[];
  budget: "low" | "medium" | "high";
  cookSkill: "beginner" | "intermediate" | "advanced";
  retailer: "instacart" | "wholefoods" | "none";
  zip: string;
}

const DEFAULT_PREFS: UserPrefs = {
  household: 2,
  diet: [],
  allergies: [],
  dislikes: [],
  cuisines: ["Mediterranean", "Asian", "American"],
  budget: "medium",
  cookSkill: "intermediate",
  retailer: "none",
  zip: "",
};

interface AppState {
  ready: boolean;
  prefs: UserPrefs;
  setPrefs: (prefs: UserPrefs) => Promise<void>;
  plans: MealPlan[];
  currentPlanId: string | null;
  currentPlan: MealPlan | null;
  savePlan: (plan: MealPlan) => Promise<void>;
  setCurrentPlan: (id: string) => Promise<void>;
  // ─────────────────────────────────────────────────────────────────
  // PRD §8 Plan Review mutations (WS5+; client-side until WS7)
  // ─────────────────────────────────────────────────────────────────
  /** PRD §8.3.6 — assign a meal to a specific day in the plan. */
  assignDayToPlanItem: (
    planId: string,
    planItemId: string,
    day: DayOfWeek,
  ) => Promise<void>;
  /** PRD §8.3.6 — clear day assignment; meal moves to Unscheduled cluster. */
  unassignDayFromPlanItem: (
    planId: string,
    planItemId: string,
  ) => Promise<void>;
  /** PRD §8.3.8 — add a meal (existing Meal id) to a plan, optionally with day. */
  addMealToPlan: (
    planId: string,
    mealId: string,
    day?: DayOfWeek,
  ) => Promise<void>;
  /** PRD §8.4.5 — Compost from plan: removes MealPlanItem; Meal stays in My Meals. */
  removeMealFromPlan: (
    planId: string,
    planItemId: string,
  ) => Promise<void>;
  /** PRD §8.4.2 — Change Meal: repoint planItem.mealId to a different Meal. */
  changeMealForPlanItem: (
    planId: string,
    planItemId: string,
    newMealId: string,
  ) => Promise<void>;
  /** PRD §8.4.3 — Change Recipe (this-week-only): writes recipeOverrideJson; mealId unchanged. */
  changeRecipeForPlanItem: (
    planId: string,
    planItemId: string,
    override: RecipeOverride,
  ) => Promise<void>;
  /** WS7-7-A B5 — set per-instance servings (servingsOverride) for a plan item;
   *  flows to this plan's grocery list. `null` clears the override. */
  setServingsForPlanItem: (
    planId: string,
    planItemId: string,
    servings: number | null,
  ) => Promise<void>;
  /** PRD §2.5 + §8.4.3 — promote a plan-item's recipeOverrideJson into the underlying Meal record. Clears the override after promotion. */
  promoteRecipeOverrideToMeal: (
    planId: string,
    planItemId: string,
  ) => Promise<void>;
  /** PRD §8 / §11 — rename a plan. Real persistence WS7. */
  updatePlanName: (planId: string, name: string) => Promise<void>;
  /** PRD §8 / §11 — update a plan's start/end dates. */
  updatePlanDateRange: (
    planId: string,
    range: { startDate?: string; endDate?: string },
  ) => Promise<void>;
  /** WS7-6 (E) Model 2 — make this plan the This-Week winner. Routes through
   *  PATCH /plans/:id { isActiveThisWeek: true }; the resolver demotes prior
   *  actives silently (Model 2 has no constraint to reject). Drives the
   *  "Cook This Week" chip in Plan Review. */
  setPlanActiveThisWeek: (planId: string) => Promise<void>;
  /** PRD §10.5 — save a dish to user's library. WS7-6 Block 1E wires this
   *  to POST /me/dishes; returns the server-canonical id. NOTE: edit mode
   *  (dish.id present) still creates a NEW dish — PATCH /me/dishes/:id is
   *  out of scope for 1E. */
  saveDish: (dish: DishDraft) => Promise<{ id: string }>;
  /** PRD §10.4 / WS7-6 Block 1E — save a Meal-Builder draft (Mode B manual,
   *  Mode C combine, or imported draft) to the user's library. POSTs to
   *  /me/meals and returns the new meal id plus the canonical dish ids the
   *  link rows now point at. Callers use `id` to chain into addMealToPlan
   *  for the "save + add to plan" entry. */
  saveMeal: (input: SaveMealInput) => Promise<SaveMealResponse>;
  /** PRD §8.4.4 + §2.5 — global edit of a saved Meal. PATCHes /me/meals/:id;
   *  invalidates the meals list AND the plans cache (a global meal edit
   *  affects every plan that uses it). Used by both the Meal Detail edit
   *  flow (library context, no prompt) and the §2.5 "Apply always" branch
   *  from a plan-context Meal Builder edit. Throws on failure. */
  updateMeal: (
    id: string,
    patch: UpdateMealInput,
  ) => Promise<UpdateMealResponse>;
  /** PRD §8.4.5 / §10.5 — global edit of a saved Dish. PATCHes /me/dishes/:id;
   *  invalidates the dishes list/detail AND the plans cache (a global dish
   *  edit can affect any plan that links it via meal sub-graph). Wired-but-
   *  unconsumed in WS7-6 1A — dish-builder.tsx's edit mode currently still
   *  creates a new dish on save; pointing it at updateDish requires the same
   *  server-backed hydration swap meal-builder got in 1G (D-WS7-092). */
  updateDish: (
    id: string,
    patch: UpdateDishInput,
  ) => Promise<UpdateDishResponse>;
  /** PRD §14.9.1 — update user's display name. PATCHes /me/profile. */
  updateUserName: (name: string) => Promise<void>;
  /** PRD §14.9.1 — request an email change. POSTs /me/email/request-change;
   *  the server emails a verification link. The verify-side landing screen
   *  lands in WS7-2 Block D. Throws on failure. */
  requestEmailChange: (newEmail: string) => Promise<void>;
  /** PRD §14.9.1 — update user's phone. PATCHes /me/profile. */
  updateUserPhone: (phone: string) => Promise<void>;
  /** PRD §14.9.1 — change password. PATCHes /me/password; the server
   *  bcrypt-compares currentPassword. Throws on failure. */
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  /** PRD §14.9.2 — update user preferences. PATCHes /me/preferences. Accepts
   *  a partial: onboarding-step-3 sends only the fields the user actually set
   *  (WS7-2-E Bug 3), preferences.tsx sends the full edited form. */
  updateUserPreferences: (prefs: Partial<UserPreferencesData>) => Promise<void>;
  /** D-WS7-025 — toggle marketing-consent flags on User. Optimistic: flips
   *  the auth cache immediately, rolls back + rethrows on API error. */
  updateMarketingConsent: (patch: {
    marketingConsentEmail?: boolean;
    marketingConsentSms?: boolean;
  }) => Promise<void>;
  /** WS7-2 Block C (D-WS7-011) — flip onboardingComplete on User. PATCHes
   *  /me/profile and field-merges the flag into the auth cache so the
   *  routing state machine re-evaluates. Throws on failure. */
  completeOnboarding: () => Promise<void>;
  /** PRD §14.9.4 — initiate account deactivation. Real soft-delete +
   *  Stripe cancellation lands in WS7. */
  deactivateAccount: () => Promise<void>;
  /** WS7-4-B c8 — Use Plan flow (PRD §9.2.5). Copy a Featured / Top-Rated /
   *  Hosting / owner-private Template into a new MealPlanInstance owned by
   *  the current user, with optimizationNotes carried over and useCount
   *  incremented on the Template server-side. Returns the new Instance id so
   *  the caller can navigate to `/plan/[id]`. Throws (ApiError 404 / 429 /
   *  500, UnauthenticatedError 401, ApiSchemaError) on failure. */
  useTemplateAsPlan: (templateId: string) => Promise<{ instanceId: string }>;
  /** WS7-5b-mobile Block C (D-WS7-059) — AddMealToPlanSheet "Create new plan"
   *  flow. Creates an empty undated MealPlanInstance, adds the seed meal as
   *  the first item (slot=dinner, no day), and returns the new plan id so the
   *  caller can navigate to Plan Review. The plans-list cache is invalidated
   *  after create (so the new plan appears in the user's list even if the
   *  add-meal call subsequently fails — the empty-plan-with-error MVP path).
   *  Throws on either step's failure; on add-meal failure the empty plan
   *  remains. */
  createPlanWithMeal: (mealId: string) => Promise<{ planId: string }>;
  /** WS7-4-E c2 — true while a POST /plans/:id/recalc-macros is in flight
   *  for any plan. Plan Review's daily-averages card reads this to show a
   *  non-blocking inline loading shim (Q2:A). Implements Ruling 11: when a
   *  mutation response carries macrosStale: true, the AppContext fires
   *  recalc-macros, flips this flag on BEFORE the first invalidateQueries
   *  (so refetch #1 doesn't briefly render macros computed without the new
   *  uncached dish), then flips off after recalc settles. */
  isMacrosRecalcInFlight: boolean;
  groceries: GroceryItem[];
  toggleGrocery: (id: string) => Promise<void>;
  // ── Grocery list system (PRD §12; WS7-7-A B3 wires real persistence) ──
  /** PRD §12.6.2 — persist item checked state. WS7-7-A B3: PATCH item
   *  { isChecked }. Returns the server row; throws on failure so the caller
   *  reverts its optimistic update. */
  toggleGroceryItemCompleted: (
    listId: string,
    itemId: string,
    isChecked: boolean,
  ) => Promise<GroceryListItem>;
  /** PRD §12.7 — persist per-list staple opt-in. WS7-7-A B3: PATCH item
   *  { stapleOptedIn }. Returns the server row; throws on failure. */
  toggleGroceryStapleSelection: (
    listId: string,
    itemId: string,
    optedIn: boolean,
  ) => Promise<GroceryListItem>;
  /** PRD §12.9 — persist an inline quantity/unit edit. WS7-7-A B3: PATCH
   *  item { quantity, unit }. Returns the server row; throws on failure. */
  updateGroceryItemQuantity: (
    listId: string,
    itemId: string,
    quantity: number,
    unit: string,
  ) => Promise<GroceryListItem>;
  /** PRD §12.5 — clarify-any-time (WS7-7-A B5). `resolution` non-null writes
   *  userResolvedTo (flips isAmbiguous→false, projection-rendered); `null` is
   *  "leave-as-is" → acknowledgeAmbiguity (clears the flag, no resolution
   *  value). Returns the server row; throws on failure. */
  resolveGroceryItemAmbiguity: (
    listId: string,
    itemId: string,
    resolution: string | null,
  ) => Promise<GroceryListItem>;
  /** PRD §12.6.1 — append an item to a grocery list. 6c-6-C wired the
   *  payload to the real POST /grocery-lists/:id/items endpoint; the
   *  returned item carries the server-generated id so the screen can
   *  reconcile its optimistic local-${Date.now()} row. */
  addGroceryItem: (
    listId: string,
    payload: AddItemPayload,
  ) => Promise<GroceryListItem>;
  /** PRD §12.9 — soft-delete an item. WS7-7-A B3: DELETE item. Throws on
   *  failure so the caller restores its optimistic removal. */
  removeGroceryItem: (listId: string, itemId: string) => Promise<void>;
  /** PRD §12.9 — undo a soft-delete. WS7-7-A B3: POST item/restore;
   *  resurrects the SAME row id. Returns the restored server row. */
  restoreGroceryItem: (
    listId: string,
    itemId: string,
  ) => Promise<GroceryListItem>;
  /** PRD §12.6.3 — mark shopping done. Reversible. WS7-7-A B3: PATCH list
   *  { status }. Returns the new mobile-side status. */
  markGroceryShoppingDone: (
    listId: string,
    done: boolean,
  ) => Promise<GroceryList["status"]>;
  favorites: string[];
  toggleFavorite: (recipeId: string) => Promise<void>;
  isFavorite: (recipeId: string) => boolean;
  isPremium: boolean;
  setPremium: (v: boolean) => Promise<void>;
  onboardingComplete: boolean;
  setOnboardingComplete: (v: boolean) => Promise<void>;
  // ── Transient onboarding state (WS5 stub) ──
  // Holds in-progress onboarding form values across navigation so
  // step 2 ↔ step 3 ↔ wizard-results refine all restore the user's
  // entries. WS7 replaces this with real API persistence via
  // getCurrentUserPreferences().
  /** Step 2 partial form state — null until first save. */
  onboardingStep2Draft: Step2Draft | null;
  setOnboardingStep2Draft: (draft: Step2Draft) => void;
  /** Step 3 partial form state — null until first save. */
  onboardingStep3Draft: Step3Draft | null;
  setOnboardingStep3Draft: (draft: Step3Draft) => void;
  // ─────────────────────────────────────────────────────────────────
  // DEV-ONLY scaffolding (WS6 6b-1.6). Removed at WS7-CLOSE.
  // Exposed unconditionally on the context; gated at the call site
  // (Profile screen wraps in __DEV__).
  // ─────────────────────────────────────────────────────────────────
  /** Inject the demo plan as currentPlan so Hans can reach Plan Review. */
  injectDevTestPlan: () => Promise<void>;
  /** Wipe AsyncStorage and reset all in-memory state to defaults. */
  resetAllDevState: () => Promise<void>;
}

const AppCtx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { logout, user: authUser } = useAuth();
  const [ready, setReady] = useState(false);
  const [prefs, setPrefsState] = useState<UserPrefs>(DEFAULT_PREFS);
  const [plans, setPlans] = useState<MealPlan[]>([]);
  const [currentPlanId, setCurrentPlanIdState] = useState<string | null>(null);
  const [groceries, setGroceries] = useState<GroceryItem[]>([]);
  // WS7-2 Block B Commit 4: favorites are server-owned. React Query is the
  // cache; the public `favorites` / `toggleFavorite` / `isFavorite` surface
  // below is a read-through facade so consumers stay unchanged.
  const favoritesQuery = useQuery({
    queryKey: ["me", "favorites"],
    queryFn: () => meAPI.getFavorites(),
    enabled: !!authUser,
  });
  const favorites = favoritesQuery.data ?? [];
  const [isPremium, setIsPremiumState] = useState(false);
  const [onboardingComplete, setOnboardingCompleteState] = useState(false);
  const [onboardingStep2Draft, setOnboardingStep2DraftState] =
    useState<Step2Draft | null>(null);
  const [onboardingStep3Draft, setOnboardingStep3DraftState] =
    useState<Step3Draft | null>(null);

  // WS7-4-E c2 — counter of in-flight POST /plans/:id/recalc-macros calls.
  // Exposed to consumers as `isMacrosRecalcInFlight = count > 0`. A counter
  // (not a single boolean) handles rapid-fire mutations cleanly: each
  // dispatchRecalcMacros increments on entry and decrements on settle, so
  // overlapping recalcs still resolve to "in flight" until ALL complete.
  const [macrosRecalcInFlightCount, setMacrosRecalcInFlightCount] =
    useState(0);

  // WS7-4-E c2 — hybrid recalc dispatcher (Ruling 11). Called after a
  // mutation whose response carries macrosStale: true. Fires the recalc
  // POST in the background; on success, invalidates ["plans", planId] so
  // Plan Review refetches the GET payload with fresh macroDailyAverage.
  // Failures are swallowed (warn-only) — the underlying mutation has
  // already succeeded; an AI estimation failure is not a user-facing error.
  // Per the c2 ordering rule, callers raise the flag BEFORE the first
  // invalidate so the inline loading shim covers refetch #1 too (otherwise
  // the user briefly sees stale macros render between mutation-resolve and
  // recalc-complete).
  const dispatchRecalcMacros = useCallback(
    (planId: string): void => {
      void (async () => {
        try {
          await recalcPlanMacros(planId);
          queryClient.invalidateQueries({ queryKey: ["plans", planId] });
        } catch (err) {
          // PRD §8.3.5 redline — "brief loading state while AI estimates."
          // A recalc failure is best-effort: the user's mutation succeeded
          // and stale (cached) values remain in the GET payload. Logging
          // only; no rollback, no rethrow.
          console.warn("[recalc-macros] failed", { planId, err });
        } finally {
          setMacrosRecalcInFlightCount((n) => Math.max(0, n - 1));
        }
      })();
    },
    [queryClient],
  );

  // Pattern shared by every mutator that can return macrosStale. Bumps the
  // flag BEFORE the cache invalidations (so the inline shim mounts immediately
  // and stays mounted across refetch #1), then runs the standard plans-cache
  // invalidations, then kicks off the recalc.
  const handleMutationResult = useCallback(
    (planId: string, macrosStale: boolean): void => {
      if (macrosStale) {
        setMacrosRecalcInFlightCount((n) => n + 1);
      }
      queryClient.invalidateQueries({ queryKey: ["plans", planId] });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      // WS7-6 (E) Block 2 §5 — Home's hero card (GET /home) is independent of
      // the plans cache, so every plan mutation must also invalidate ["home"]
      // (a valid prefix of ["home","payload"]) to keep "tonight" / "this week"
      // in sync with the activation flip and any date / item mutation.
      queryClient.invalidateQueries({ queryKey: ["home"] });
      if (macrosStale) {
        dispatchRecalcMacros(planId);
      }
    },
    [queryClient, dispatchRecalcMacros],
  );

  const setOnboardingStep2Draft = useCallback((draft: Step2Draft) => {
    setOnboardingStep2DraftState(draft);
    console.log("[AppContext] step 2 draft saved", draft);
  }, []);

  const setOnboardingStep3Draft = useCallback((draft: Step3Draft) => {
    setOnboardingStep3DraftState(draft);
    console.log("[AppContext] step 3 draft saved", draft);
  }, []);

  useEffect(() => {
    (async () => {
      // One-time stale-cleanup: favorites moved to React Query in Block B
      // Commit 4. Discard the orphaned kiwi:favorites AsyncStorage entry
      // (no migration — server is the source of truth).
      void removeKey("favorites");
      const [p, pl, cur, g, prem, ob] = await Promise.all([
        loadJSON<UserPrefs>("prefs", DEFAULT_PREFS),
        loadJSON<MealPlan[]>("plans", []),
        loadJSON<string | null>("currentPlanId", null),
        loadJSON<GroceryItem[]>("groceries", []),
        loadJSON<boolean>("premium", false),
        loadJSON<boolean>("onboardingComplete", false),
      ]);
      setPrefsState(p);
      let plansToUse = pl;
      let curId = cur;
      if (plansToUse.length === 0) {
        const seed = defaultPlan();
        plansToUse = [seed];
        curId = seed.id;
        await saveJSON("plans", plansToUse);
        await saveJSON("currentPlanId", curId);
      }
      let groceriesToUse = g;
      if (groceriesToUse.length === 0 && curId) {
        const cp = plansToUse.find((x) => x.id === curId);
        if (cp) {
          groceriesToUse = buildGroceryList(cp);
          await saveJSON("groceries", groceriesToUse);
        }
      }
      setPlans(plansToUse);
      setCurrentPlanIdState(curId);
      setGroceries(groceriesToUse);
      setIsPremiumState(prem);
      setOnboardingCompleteState(ob);
      setReady(true);
    })();
  }, []);

  const setPrefs = useCallback(async (p: UserPrefs) => {
    setPrefsState(p);
    await saveJSON("prefs", p);
  }, []);

  const persistGroceriesFor = useCallback(
    async (plan: MealPlan) => {
      const ng = buildGroceryList(plan);
      setGroceries(ng);
      await saveJSON("groceries", ng);
    },
    [],
  );

  const savePlan = useCallback(
    async (plan: MealPlan) => {
      const updated = [plan, ...plans.filter((p) => p.id !== plan.id)];
      setPlans(updated);
      setCurrentPlanIdState(plan.id);
      await Promise.all([
        saveJSON("plans", updated),
        saveJSON("currentPlanId", plan.id),
      ]);
      await persistGroceriesFor(plan);
    },
    [plans, persistGroceriesFor],
  );

  const setCurrentPlan = useCallback(
    async (id: string) => {
      setCurrentPlanIdState(id);
      await saveJSON("currentPlanId", id);
      const plan = plans.find((p) => p.id === id);
      if (plan) await persistGroceriesFor(plan);
    },
    [plans, persistGroceriesFor],
  );

  // ─────────────────────────────────────────────────────────────────
  // PRD §8 Plan Review mutation scaffolds (WS5+; real wiring in WS7)
  // ─────────────────────────────────────────────────────────────────

  // WS7-4-D c6 — real API wiring for assign/unassign day. Q-P0-8 mutators
  // return Promise<void>; React Query invalidation drives the UI refresh.
  // WS7-4-E c2 — consumes macrosStale via handleMutationResult (Ruling 11).
  const assignDayToPlanItem = useCallback(
    async (
      planId: string,
      planItemId: string,
      day: DayOfWeek,
    ): Promise<void> => {
      const response = await patchPlanItem(planId, planItemId, {
        assignedDayOfWeek: day,
      });
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  const unassignDayFromPlanItem = useCallback(
    async (planId: string, planItemId: string): Promise<void> => {
      const response = await patchPlanItem(planId, planItemId, {
        assignedDayOfWeek: null,
      });
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  // WS7-4-D c7 — real API wiring for add/remove meal. Slot defaults to
  // "dinner" per Q-P0-5; sent explicitly for unambiguous wire shape.
  const addMealToPlan = useCallback(
    async (
      planId: string,
      mealId: string,
      day?: DayOfWeek,
    ): Promise<void> => {
      const response = await postPlanItem(planId, {
        mealId,
        slot: "dinner",
        assignedDayOfWeek: day ?? null,
      });
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  const removeMealFromPlan = useCallback(
    async (planId: string, planItemId: string): Promise<void> => {
      const response = await deletePlanItem(planId, planItemId);
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  // WS7-4-D c8 — real API wiring. Q-P0-3 (alpha) atomic server-side
  // mealId-swap; mobile sends { mealId: newMealId } as a sole-field PATCH
  // (Q-P1-4 v1 restriction). Day/slot/notes preserved server-side per
  // Q-P1-4 preservation matrix; mutator returns Promise<void> + invalidates.
  const changeMealForPlanItem = useCallback(
    async (
      planId: string,
      planItemId: string,
      newMealId: string,
    ): Promise<void> => {
      const response = await patchPlanItem(planId, planItemId, {
        mealId: newMealId,
      });
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  // WS7-4-D c9 — scaffold mutators (no UI consumer yet per Phase 1 A6).
  // Wired through to the server so a future UI consumer (Just-this-time
  // recipe edit, promote-to-meal CTA) gets the same Promise<void> +
  // invalidate contract as the rest of the §8 Plan Review surface.
  const changeRecipeForPlanItem = useCallback(
    async (
      planId: string,
      planItemId: string,
      override: RecipeOverride,
    ): Promise<void> => {
      const response = await patchPlanItem(planId, planItemId, {
        recipeOverrideJson: override,
      });
      handleMutationResult(planId, response.macrosStale);
      // WS7-7-A B5 (Issue B) — the meal-detail screen caches the resolved
      // recipe under ["meals","detail",mealId,planItemId] with a 60s staleTime
      // and stays mounted under the change-recipe screen. handleMutationResult
      // only invalidates the plans/home caches, so on router.back() the pre-
      // override read would be served stale. Prefix-invalidate meals-detail
      // (we have planItemId but not mealId) to force the ?planItemId re-read.
      queryClient.invalidateQueries({ queryKey: ["meals", "detail"] });
    },
    [handleMutationResult, queryClient],
  );

  const promoteRecipeOverrideToMeal = useCallback(
    async (planId: string, planItemId: string): Promise<void> => {
      const response = await promoteItemOverride(planId, planItemId);
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  // WS7-7-A B5 — per-instance servings. Bumps the plan revision server-side
  // (D-WS7-134), so the next grocery-list GET reconciles the new quantities.
  const setServingsForPlanItem = useCallback(
    async (
      planId: string,
      planItemId: string,
      servings: number | null,
    ): Promise<void> => {
      const response = await patchPlanItem(planId, planItemId, {
        servingsOverride: servings,
      });
      handleMutationResult(planId, response.macrosStale);
    },
    [handleMutationResult],
  );

  // WS7-4-E c2 — Q3:A — plan-level mutators also consume macrosStale for
  // symmetry. patchPlan's response.macrosStale is optional (server forces
  // false on the noop branch + on name-only changes); coalesce to false.
  const updatePlanName = useCallback(
    async (planId: string, name: string): Promise<void> => {
      const response = await patchPlan(planId, { name });
      handleMutationResult(planId, response.macrosStale ?? false);
    },
    [handleMutationResult],
  );

  const updatePlanDateRange = useCallback(
    async (
      planId: string,
      range: { startDate?: string; endDate?: string },
    ): Promise<void> => {
      const response = await patchPlan(planId, range);
      handleMutationResult(planId, response.macrosStale ?? false);
    },
    [handleMutationResult],
  );

  // WS7-6 (E) Block 2 §5 — Model 2 activation wrapper. PATCH /plans/:id with
  // { isActiveThisWeek: true }; the server resolver demotes any prior winner.
  // macrosStale is forced false on this flip server-side (no item membership
  // change), so coalesce to false for symmetry with other plan-level mutators.
  const setPlanActiveThisWeek = useCallback(
    async (planId: string): Promise<void> => {
      const response = await patchPlan(planId, { isActiveThisWeek: true });
      handleMutationResult(planId, response.macrosStale ?? false);
    },
    [handleMutationResult],
  );

  // WS7-6 Block 1E — POST /me/dishes. Translates the DishDraft form shape to
  // the server's save-canonical payload (only the fields the route accepts;
  // kiwiAssist flags + macros = 0 are dropped). Edit mode (dish.id present)
  // still hits POST — PATCH /me/dishes/:id is a future block.
  const saveDish = async (dish: DishDraft): Promise<{ id: string }> => {
    const macros: {
      caloriesPerServing?: number;
      proteinGPerServing?: number;
      carbsGPerServing?: number;
      fatGPerServing?: number;
    } = {};
    if (dish.caloriesPerServing > 0) {
      macros.caloriesPerServing = dish.caloriesPerServing;
    }
    if (dish.proteinGPerServing > 0) {
      macros.proteinGPerServing = dish.proteinGPerServing;
    }
    if (dish.carbsGPerServing > 0) {
      macros.carbsGPerServing = dish.carbsGPerServing;
    }
    if (dish.fatGPerServing > 0) {
      macros.fatGPerServing = dish.fatGPerServing;
    }
    const result = await saveDishAPI({
      title: dish.name,
      description: dish.notes ?? null,
      estimatedTimeMinutes: dish.estimatedTimeMinutes,
      servingsDefault: dish.servingsDefault,
      sourceType: "manual",
      macros: Object.keys(macros).length > 0 ? macros : undefined,
      ingredients: dish.ingredients.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
      })),
      steps: dish.steps.map((s) => ({
        text: s.text,
        estimatedMinutes: s.estimatedMinutes,
        isTimingSensitive: s.isTimingSensitive,
      })),
    });
    // Refresh the Dishes-tab list so the new dish appears (and so the Mode-C
    // picker in meal-builder sees it on its next render).
    await queryClient.invalidateQueries({ queryKey: ["dishes", "list"] });
    return { id: result.id };
  };

  // WS7-6 Block 1E — POST /me/meals. Caller has already translated UI
  // difficulty (`hard → fancy`) via toServerDifficulty before reaching here;
  // this wrapper only adds cache invalidation so the Meals tab refreshes.
  const saveMeal = async (
    input: SaveMealInput,
  ): Promise<SaveMealResponse> => {
    const result = await saveMealAPI(input);
    await queryClient.invalidateQueries({ queryKey: ["meals", "list"] });
    return result;
  };

  // WS7-6 1F — PATCH /me/meals/:id. Global edit of a saved meal. Used by
  // both §8.4.4 (library-context Meal Detail edit, no prompt) and the §2.5
  // "Apply always" branch from a plan-context edit. Caller has already
  // translated UI difficulty (`hard → fancy`) before reaching here.
  // Invalidations: ["meals","list"] for the Meals tab AND ["meals","detail",id]
  // for the Meal Detail screen; ["plans"] prefix because every plan that
  // references this meal renders its meta/sub-graph at read time.
  const updateMeal = async (
    id: string,
    patch: UpdateMealInput,
  ): Promise<UpdateMealResponse> => {
    const result = await updateMealAPI(id, patch);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["meals", "list"] }),
      queryClient.invalidateQueries({ queryKey: ["meals", "detail", id] }),
      // WS7-7-A B5 follow-on (D-WS7-141) — a dishes[] edit PATCHes the meal
      // via wipe-and-recreate (rematerializeMeal), which deletes the old Dish
      // rows and mints new ones. The Recipes "My Dishes" sub-tab
      // (["dishes","list"]) and dish-detail (["dishes","detail",id]) are served
      // from caches updateMeal previously never touched — so an Apply-Always
      // ingredient edit showed stale dish data there even though the canonical
      // write succeeded. Invalidate symmetrically with updateDish. The detail
      // key is a BARE PREFIX: recreate changes dish ids, so the client can't
      // target the old/new id — invalidate the whole dishes/detail namespace.
      queryClient.invalidateQueries({ queryKey: ["dishes", "list"] }),
      queryClient.invalidateQueries({ queryKey: ["dishes", "detail"] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
      // WS7-6 (E) Block 2 §5 — Home's hero (GET /home) renders meal title /
      // minutes / calories from the plan's meals; a global meal edit must
      // refresh it.
      queryClient.invalidateQueries({ queryKey: ["home"] }),
    ]);
    return result;
  };

  // WS7-6 1A — PATCH /me/dishes/:id. Symmetric to updateMeal: caller has
  // already translated UI difficulty via toServerDifficulty before reaching
  // here. Plans invalidation is included because a global dish edit can
  // affect any plan that renders the meal-sub-graph containing this dish.
  // Wired-but-unconsumed today — see the AppState interface comment.
  const updateDish = async (
    id: string,
    patch: UpdateDishInput,
  ): Promise<UpdateDishResponse> => {
    const result = await updateDishAPI(id, patch);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dishes", "list"] }),
      queryClient.invalidateQueries({ queryKey: ["dishes", "detail", id] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
      // WS7-6 (E) Block 2 §5 — a global dish edit can affect any plan's
      // meal sub-graph, including the one the Home hero renders.
      queryClient.invalidateQueries({ queryKey: ["home"] }),
    ]);
    return result;
  };

  // WS7-2 Block B: profile mutators write through PATCH /me/profile and
  // field-merge the result into the ['auth','me'] cache. Field-merge (not
  // replace) is required because /me/profile's response omits `subscription`
  // — a replace would drop it. Errors propagate to the caller.
  const updateUserName = async (name: string): Promise<void> => {
    // The mobile profile screen edits a single display name; split it for
    // the server's firstName/lastName contract. Block C introduces proper
    // first/last inputs and a cleaner mutator signature.
    const [firstName, ...rest] = name.trim().split(/\s+/);
    const lastName = rest.join(" ");
    const patch: { firstName?: string; lastName?: string } = {};
    if (firstName) patch.firstName = firstName;
    if (lastName) patch.lastName = lastName;
    const { user } = await meAPI.patchProfile(patch);
    queryClient.setQueryData<User | null>(["auth", "me"], (prev) =>
      prev ? { ...prev, ...user } : prev,
    );
  };

  // WS7-2 Block C: the request side of the two-step email change. POSTs
  // /me/email/request-change; the server mints a verification token and
  // (D-WS7-022) logs the link until real email infra ships. The verify-side
  // deep-link screen is Block D — no cache write happens here, the email
  // only changes once the user clicks through. Errors propagate to the caller.
  const requestEmailChange = async (newEmail: string): Promise<void> => {
    await meAPI.requestEmailChange({ newEmail });
  };

  // WS7-2 Block C: PATCH /me/password. The server bcrypt-compares
  // currentPassword and returns 400 invalid_current_password on mismatch;
  // that rejection propagates so the screen can surface it inline.
  const changePassword = async (
    currentPassword: string,
    newPassword: string,
  ): Promise<void> => {
    await meAPI.patchPassword({ currentPassword, newPassword });
  };

  const updateUserPhone = async (phone: string): Promise<void> => {
    const { user } = await meAPI.patchProfile({ phone });
    queryClient.setQueryData<User | null>(["auth", "me"], (prev) =>
      prev ? { ...prev, ...user } : prev,
    );
  };

  const updateUserPreferences = async (
    prefs: Partial<UserPreferencesData>,
  ): Promise<void> => {
    await meAPI.patchPreferences(prefs);
    // Invalidate so the next getPreferences read (Block C wires the screen)
    // refetches the server-merged row rather than serving a stale cache.
    await queryClient.invalidateQueries({ queryKey: ["me", "preferences"] });
  };

  // WS7-2 Block C (D-WS7-025): marketing consent lives on User. Optimistic —
  // flip the ['auth','me'] cache up front so the Switch responds instantly,
  // then PATCH /me/profile and field-merge the authoritative response. On
  // failure restore the pre-toggle snapshot and rethrow so the screen can
  // surface the error.
  const updateMarketingConsent = async (patch: {
    marketingConsentEmail?: boolean;
    marketingConsentSms?: boolean;
  }): Promise<void> => {
    const snapshot = queryClient.getQueryData<User | null>(["auth", "me"]);
    queryClient.setQueryData<User | null>(["auth", "me"], (prev) =>
      prev ? { ...prev, ...patch } : prev,
    );
    try {
      const { user } = await meAPI.patchProfile(patch);
      queryClient.setQueryData<User | null>(["auth", "me"], (prev) =>
        prev ? { ...prev, ...user } : prev,
      );
    } catch (err) {
      queryClient.setQueryData<User | null>(["auth", "me"], snapshot ?? null);
      throw err;
    }
  };

  // WS7-2 Block C (D-WS7-011): onboarding-step-3's finish flips this flag.
  // Field-merge the routing flag into ['auth','me'] so index.tsx's routing
  // state machine advances onboarding → first-run-destination reactively.
  const completeOnboarding = async (): Promise<void> => {
    const { user } = await meAPI.patchProfile({ onboardingComplete: true });
    queryClient.setQueryData<User | null>(["auth", "me"], (prev) =>
      prev ? { ...prev, ...user } : prev,
    );
  };

  const deactivateAccount = async (): Promise<void> => {
    await meAPI.deactivateAccount();
    // Server soft-deletes (accountStatus → paused). Drop the local session
    // so the user lands back on the welcome screen.
    await logout();
  };

  // WS7-4-B c8 — Use Plan flow. Mirrors the meAPI mutator pattern (typed
  // helper + cache invalidation); no optimistic state. The server is the
  // source of truth: it creates the Instance, demotes prior actives, copies
  // items + optimizationNotes, increments useCount, and emits the
  // plan_used_from_template activity row. Invalidate the plans-list cache
  // so the new Instance shows up in my_plans + the This-Week callout on the
  // next read.
  const useTemplateAsPlan = useCallback(
    async (templateId: string) => {
      const { instanceId } = await useTemplateAPI(templateId);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      // WS7-6 (E) Block 2 §5 — use-template creates a new Instance + demotes
      // prior actives server-side; Home's hero needs the refreshed payload.
      queryClient.invalidateQueries({ queryKey: ["home"] });
      return { instanceId };
    },
    [queryClient],
  );

  // WS7-5b-mobile Block C — D-WS7-059 real wiring for the "Create new plan"
  // card in AddMealToPlanSheet. Two server calls in sequence:
  //   1) POST /plans with `{}` (no dates per the locked create-with-one-meal
  //      contract — body fields are all optional server-side).
  //   2) POST /plans/:id/items with mealId + slot="dinner" (PRD §2.4 lets
  //      day assignment stay null; user assigns in Plan Review).
  // Cache hygiene: the plans-list cache is invalidated right after step (1)
  // so the new plan appears in My Plans even when step (2) throws (Block C
  // ruling: empty-plan-with-error is the MVP partial-failure outcome; no
  // cleanup). On full success, handleMutationResult fires the standard
  // plan-detail invalidation + macrosStale recalc pipeline.
  const createPlanWithMeal = useCallback(
    async (mealId: string): Promise<{ planId: string }> => {
      const created = await createPlanAPI({});
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      // WS7-6 (E) Block 2 §5 — Home's hero may flip to/from "empty" when
      // the user gains their first plan; invalidate eagerly so the empty-
      // plan-with-error MVP path still refreshes Home (step 2 may throw
      // before handleMutationResult runs).
      queryClient.invalidateQueries({ queryKey: ["home"] });
      const response = await postPlanItem(created.instanceId, {
        mealId,
        slot: "dinner",
      });
      handleMutationResult(created.instanceId, response.macrosStale);
      return { planId: created.instanceId };
    },
    [queryClient, handleMutationResult],
  );

  const toggleGrocery = useCallback(
    async (id: string) => {
      const updated = groceries.map((g) =>
        g.id === id ? { ...g, checked: !g.checked } : g,
      );
      setGroceries(updated);
      await saveJSON("groceries", updated);
    },
    [groceries],
  );

  // ── Grocery list mutators (PRD §12; WS7-7-A B3 wires real persistence) ──
  // Each persists then invalidates the Groceries-tab list query so its
  // itemCount/status badge reflects the change (the detail screen manages
  // its own optimistic state and reconciles to the returned row). Errors
  // bubble so the screen reverts its optimistic update and surfaces the
  // failure — no silent revert (§12.9).
  const invalidateGroceryLists = () =>
    queryClient.invalidateQueries({ queryKey: ["groceries", "list"] });

  const toggleGroceryItemCompleted = async (
    listId: string,
    itemId: string,
    isChecked: boolean,
  ): Promise<GroceryListItem> => {
    const item = await updateGroceryListItem(listId, itemId, { isChecked });
    void invalidateGroceryLists();
    return item;
  };

  const toggleGroceryStapleSelection = async (
    listId: string,
    itemId: string,
    optedIn: boolean,
  ): Promise<GroceryListItem> => {
    const item = await updateGroceryListItem(listId, itemId, {
      stapleOptedIn: optedIn,
    });
    void invalidateGroceryLists();
    return item;
  };

  const updateGroceryItemQuantity = async (
    listId: string,
    itemId: string,
    quantity: number,
    unit: string,
  ): Promise<GroceryListItem> => {
    const item = await updateGroceryListItem(listId, itemId, {
      quantity,
      unit,
    });
    void invalidateGroceryLists();
    return item;
  };

  // WS7-7-A B5 — clarify-any-time. Resolve (userResolvedTo) vs leave-as-is
  // (acknowledgeAmbiguity); both clear isAmbiguous server-side, differing only
  // in whether a resolution value is recorded for projection rendering.
  const resolveGroceryItemAmbiguity = async (
    listId: string,
    itemId: string,
    resolution: string | null,
  ): Promise<GroceryListItem> => {
    const item = await updateGroceryListItem(
      listId,
      itemId,
      resolution !== null
        ? { userResolvedTo: resolution }
        : { acknowledgeAmbiguity: true },
    );
    void invalidateGroceryLists();
    return item;
  };

  const addGroceryItem = async (
    listId: string,
    payload: AddItemPayload,
  ): Promise<GroceryListItem> => {
    // 6c-6-C: real wire. Errors bubble so callers (grocery-list/[id].tsx
    // optimistic-add) can roll back the local row.
    const item = await addGroceryListItem(listId, payload);
    void invalidateGroceryLists();
    return item;
  };

  const removeGroceryItem = async (
    listId: string,
    itemId: string,
  ): Promise<void> => {
    await deleteGroceryListItem(listId, itemId);
    void invalidateGroceryLists();
  };

  const restoreGroceryItem = async (
    listId: string,
    itemId: string,
  ): Promise<GroceryListItem> => {
    const item = await restoreGroceryListItem(listId, itemId);
    void invalidateGroceryLists();
    return item;
  };

  const markGroceryShoppingDone = async (
    listId: string,
    done: boolean,
  ): Promise<GroceryList["status"]> => {
    const status = await updateGroceryListStatus(
      listId,
      done ? "completed" : "active",
    );
    void invalidateGroceryLists();
    return status;
  };

  // Optimistic toggle: write the React Query cache immediately, then POST /
  // DELETE. On failure, roll the cache back to the pre-toggle state and
  // rethrow so the caller can surface the error.
  const toggleFavorite = useCallback(
    async (recipeId: string) => {
      const isFav = favorites.includes(recipeId);
      queryClient.setQueryData<string[]>(["me", "favorites"], (prev = []) =>
        isFav
          ? prev.filter((id) => id !== recipeId)
          : [...prev, recipeId],
      );
      try {
        if (isFav) await meAPI.removeFavorite(recipeId);
        else await meAPI.addFavorite(recipeId);
      } catch (err) {
        queryClient.setQueryData<string[]>(["me", "favorites"], (prev = []) =>
          isFav
            ? [...prev, recipeId]
            : prev.filter((id) => id !== recipeId),
        );
        throw err;
      }
    },
    [favorites, queryClient],
  );

  const isFavorite = useCallback(
    (recipeId: string) => favorites.includes(recipeId),
    [favorites],
  );

  const setPremium = useCallback(async (v: boolean) => {
    setIsPremiumState(v);
    await saveJSON("premium", v);
  }, []);

  const setOnboardingComplete = useCallback(async (v: boolean) => {
    setOnboardingCompleteState(v);
    await saveJSON("onboardingComplete", v);
  }, []);

  // ─────────────────────────────────────────────────────────────────
  // DEV-ONLY scaffolding (WS6 6b-1.6). Removed at WS7-CLOSE.
  // ─────────────────────────────────────────────────────────────────

  const injectDevTestPlan = useCallback(async (): Promise<void> => {
    try {
      const plan = buildDevTestPlan();
      // Replace any same-id entry — re-tap is idempotent.
      const updated = [plan, ...plans.filter((p) => p.id !== plan.id)];
      setPlans(updated);
      setCurrentPlanIdState(plan.id);
      await Promise.all([
        saveJSON("plans", updated),
        saveJSON("currentPlanId", plan.id),
      ]);
      // Diagnostic — confirms the injection ran end-to-end. Remove once
      // the affordance is proven working in Hans's workflow.
      console.log(
        "[devInjector] plans now:",
        updated.length,
        "currentPlanId:",
        plan.id,
      );
    } catch (err) {
      console.warn("[devInjector] inject failed:", err);
    }
  }, [plans]);

  const resetAllDevState = useCallback(async (): Promise<void> => {
    // Wipes everything across all prefixes (kiwi:* + auth + anything else).
    await AsyncStorage.clear();
    setPrefsState(DEFAULT_PREFS);
    setPlans([]);
    setCurrentPlanIdState(null);
    setGroceries([]);
    // Favorites live in React Query now — drop the cached query.
    queryClient.removeQueries({ queryKey: ["me", "favorites"] });
    setIsPremiumState(false);
    setOnboardingCompleteState(false);
    setOnboardingStep2DraftState(null);
    setOnboardingStep3DraftState(null);
  }, [queryClient]);

  const currentPlan = useMemo(
    () => plans.find((p) => p.id === currentPlanId) ?? null,
    [plans, currentPlanId],
  );

  const value: AppState = {
    ready,
    prefs,
    setPrefs,
    plans,
    currentPlanId,
    currentPlan,
    savePlan,
    setCurrentPlan,
    assignDayToPlanItem,
    unassignDayFromPlanItem,
    addMealToPlan,
    removeMealFromPlan,
    changeMealForPlanItem,
    changeRecipeForPlanItem,
    setServingsForPlanItem,
    promoteRecipeOverrideToMeal,
    updatePlanName,
    updatePlanDateRange,
    setPlanActiveThisWeek,
    saveDish,
    saveMeal,
    updateMeal,
    updateDish,
    updateUserName,
    requestEmailChange,
    updateUserPhone,
    changePassword,
    updateUserPreferences,
    updateMarketingConsent,
    completeOnboarding,
    deactivateAccount,
    useTemplateAsPlan,
    createPlanWithMeal,
    isMacrosRecalcInFlight: macrosRecalcInFlightCount > 0,
    groceries,
    toggleGrocery,
    toggleGroceryItemCompleted,
    toggleGroceryStapleSelection,
    updateGroceryItemQuantity,
    resolveGroceryItemAmbiguity,
    addGroceryItem,
    removeGroceryItem,
    restoreGroceryItem,
    markGroceryShoppingDone,
    favorites,
    toggleFavorite,
    isFavorite,
    isPremium,
    setPremium,
    onboardingComplete,
    setOnboardingComplete,
    onboardingStep2Draft,
    setOnboardingStep2Draft,
    onboardingStep3Draft,
    setOnboardingStep3Draft,
    injectDevTestPlan,
    resetAllDevState,
  };

  // No JSX in this file — the test runner (`node --experimental-strip-types`)
  // strips TS types but does not transform JSX. Using React.createElement
  // keeps AppContext loadable from the node:test infra (mirrors AuthContext).
  return React.createElement(AppCtx.Provider, { value }, children);
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

