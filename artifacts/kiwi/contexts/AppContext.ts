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
  type AddItemPayload,
} from "@/lib/api/grocery";
import { buildGroceryList, defaultPlan, getRecipe } from "@/lib/stubs";
import * as meAPI from "@/lib/api/me";
import { patchPlan, useTemplate as useTemplateAPI } from "@/lib/api/plans";
import { useAuth } from "@/contexts/AuthContext";
import type {
  DayOfWeek,
  DishDraft,
  GroceryItem,
  GroceryListItem,
  MealPlan,
  MealSlot,
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
  swapMealInCurrentPlan: (
    slotIndex: number,
    newRecipeId: string,
  ) => Promise<void>;
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
  /** PRD §2.5 + §8.4.3 — promote a plan-item's recipeOverrideJson into the underlying Meal record. Clears the override after promotion. */
  promoteRecipeOverrideToMeal: (
    planId: string,
    planItemId: string,
  ) => Promise<void>;
  /** PRD §8.4.x (NEW per WS5) — Find Similar: returns Meal candidates matching cuisine of the source mealId. MVP: cuisine match only. */
  findSimilarMeals: (mealId: string) => Promise<string[]>;
  /** PRD §8 / §11 — rename a plan. Real persistence WS7. */
  updatePlanName: (planId: string, name: string) => Promise<void>;
  /** PRD §8 / §11 — update a plan's start/end dates. */
  updatePlanDateRange: (
    planId: string,
    range: { startDate?: string; endDate?: string },
  ) => Promise<void>;
  /** PRD §10.5 — save a dish to user's library. Real persistence WS7.
   *  WS5: log only; returns assigned id. */
  saveDish: (dish: DishDraft) => Promise<{ id: string }>;
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
  groceries: GroceryItem[];
  toggleGrocery: (id: string) => Promise<void>;
  // ── Grocery list system (PRD §12; WS5 stubs, WS7 wires real persistence) ──
  /** PRD §12.6.2 — toggle item complete (strikethrough). */
  toggleGroceryItemCompleted: (
    listId: string,
    itemId: string,
  ) => Promise<void>;
  /** PRD §12.7 — toggle universal staple selection (greyed → active). */
  toggleGroceryStapleSelection: (
    listId: string,
    itemId: string,
  ) => Promise<void>;
  /** PRD §12.6.1 — append an item to a grocery list. 6c-6-C wired the
   *  payload to the real POST /grocery-lists/:id/items endpoint; the
   *  returned item carries the server-generated id so the screen can
   *  reconcile its optimistic local-${Date.now()} row. */
  addGroceryItem: (
    listId: string,
    payload: AddItemPayload,
  ) => Promise<GroceryListItem>;
  /** PRD §12.9 — remove an item from the list. */
  removeGroceryItem: (listId: string, itemId: string) => Promise<void>;
  /** PRD §12.6.3 — mark shopping done. Reversible. */
  markGroceryShoppingDone: (listId: string, done: boolean) => Promise<void>;
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

  const swapMealInCurrentPlan = useCallback(
    async (slotIndex: number, newRecipeId: string) => {
      const plan = plans.find((p) => p.id === currentPlanId);
      if (!plan) return;
      if (!getRecipe(newRecipeId)) return;
      const newMeals: MealSlot[] = plan.meals.map((m, i) =>
        i === slotIndex ? { ...m, recipeId: newRecipeId, reason: undefined } : m,
      );
      const updatedPlan: MealPlan = { ...plan, meals: newMeals };
      const updatedPlans = plans.map((p) =>
        p.id === plan.id ? updatedPlan : p,
      );
      setPlans(updatedPlans);
      await saveJSON("plans", updatedPlans);
      await persistGroceriesFor(updatedPlan);
    },
    [plans, currentPlanId, persistGroceriesFor],
  );

  // ─────────────────────────────────────────────────────────────────
  // PRD §8 Plan Review mutation scaffolds (WS5+; real wiring in WS7)
  // ─────────────────────────────────────────────────────────────────

  const assignDayToPlanItem = async (
    planId: string,
    planItemId: string,
    day: DayOfWeek,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /plans/:planId/items/:planItemId
    console.log("[stub] assignDayToPlanItem", { planId, planItemId, day });
  };

  const unassignDayFromPlanItem = async (
    planId: string,
    planItemId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /plans/:planId/items/:planItemId
    console.log("[stub] unassignDayFromPlanItem", { planId, planItemId });
  };

  const addMealToPlan = async (
    planId: string,
    mealId: string,
    day?: DayOfWeek,
  ): Promise<void> => {
    // TODO(WS7): wire to POST /plans/:planId/items
    console.log("[stub] addMealToPlan", { planId, mealId, day });
  };

  const removeMealFromPlan = async (
    planId: string,
    planItemId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to DELETE /plans/:planId/items/:planItemId
    console.log("[stub] removeMealFromPlan", { planId, planItemId });
  };

  const changeMealForPlanItem = async (
    planId: string,
    planItemId: string,
    newMealId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /plans/:planId/items/:planItemId (mealId)
    console.log("[stub] changeMealForPlanItem", { planId, planItemId, newMealId });
  };

  const changeRecipeForPlanItem = async (
    planId: string,
    planItemId: string,
    override: RecipeOverride,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /plans/:planId/items/:planItemId (recipeOverrideJson)
    console.log("[stub] changeRecipeForPlanItem", { planId, planItemId, override });
  };

  const promoteRecipeOverrideToMeal = async (
    planId: string,
    planItemId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to POST /plans/:planId/items/:planItemId/promote-override
    console.log("[stub] promoteRecipeOverrideToMeal", { planId, planItemId });
  };

  const findSimilarMeals = async (mealId: string): Promise<string[]> => {
    // TODO(WS7): wire to GET /meals/:mealId/similar
    // MVP: cuisine-match-only (PRD §8.4.x WS5 amendment); AI semantic
    // similarity deferred to WS6+ (logged as D-WS5-XXX in handoff).
    console.log("[stub] findSimilarMeals", { mealId });
    return [];
  };

  const updatePlanName = useCallback(
    async (planId: string, name: string): Promise<void> => {
      await patchPlan(planId, { name });
      queryClient.invalidateQueries({ queryKey: ["plans", planId] });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
    [queryClient],
  );

  const updatePlanDateRange = useCallback(
    async (
      planId: string,
      range: { startDate?: string; endDate?: string },
    ): Promise<void> => {
      await patchPlan(planId, range);
      queryClient.invalidateQueries({ queryKey: ["plans", planId] });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
    [queryClient],
  );

  const saveDish = async (dish: DishDraft): Promise<{ id: string }> => {
    // TODO(WS7): wire to POST /me/dishes (create) or PATCH /me/dishes/:id (update)
    const id = dish.id ?? `dish-${Date.now()}`;
    console.log("[stub] saveDish", { id, dish });
    return { id };
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
      return { instanceId };
    },
    [queryClient],
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

  // ── Grocery list mutators (PRD §12; WS5 stubs, WS7 wires real persistence) ──
  const toggleGroceryItemCompleted = async (
    listId: string,
    itemId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /grocery-lists/{id}/items/{itemId}
    console.log("[AppContext] toggleGroceryItemCompleted", { listId, itemId });
  };

  const toggleGroceryStapleSelection = async (
    listId: string,
    itemId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /grocery-lists/{id}/items/{itemId}
    console.log("[AppContext] toggleGroceryStapleSelection", {
      listId,
      itemId,
    });
  };

  const addGroceryItem = async (
    listId: string,
    payload: AddItemPayload,
  ): Promise<GroceryListItem> => {
    // 6c-6-C: real wire. Errors bubble so callers (grocery-list/[id].tsx
    // optimistic-add) can roll back the local row.
    return await addGroceryListItem(listId, payload);
  };

  const removeGroceryItem = async (
    listId: string,
    itemId: string,
  ): Promise<void> => {
    // TODO(WS7): wire to DELETE /grocery-lists/{id}/items/{itemId}
    console.log("[AppContext] removeGroceryItem", { listId, itemId });
  };

  const markGroceryShoppingDone = async (
    listId: string,
    done: boolean,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /grocery-lists/{id} { status: done ? "completed" : "active" }
    console.log("[AppContext] markGroceryShoppingDone", { listId, done });
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
    swapMealInCurrentPlan,
    assignDayToPlanItem,
    unassignDayFromPlanItem,
    addMealToPlan,
    removeMealFromPlan,
    changeMealForPlanItem,
    changeRecipeForPlanItem,
    promoteRecipeOverrideToMeal,
    findSimilarMeals,
    updatePlanName,
    updatePlanDateRange,
    saveDish,
    updateUserName,
    requestEmailChange,
    updateUserPhone,
    changePassword,
    updateUserPreferences,
    updateMarketingConsent,
    completeOnboarding,
    deactivateAccount,
    useTemplateAsPlan,
    groceries,
    toggleGrocery,
    toggleGroceryItemCompleted,
    toggleGroceryStapleSelection,
    addGroceryItem,
    removeGroceryItem,
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

