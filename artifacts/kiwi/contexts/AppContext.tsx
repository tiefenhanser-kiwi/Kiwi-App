import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { buildDevTestPlan } from "@/lib/dev/devPlanFixture";
import { loadJSON, saveJSON } from "@/lib/storage";
import {
  addGroceryListItem,
  type AddItemPayload,
} from "@/lib/api/grocery";
import {
  buildGroceryList,
  defaultPlan,
  getRecipe,
  updateReviewPlanDateRange,
  updateReviewPlanName,
} from "@/lib/stubs";
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
  /** PRD §8 / §11 — update a plan's start/end dates. Real persistence WS7. */
  updatePlanDateRange: (
    planId: string,
    startDate: string,
    endDate: string,
  ) => Promise<void>;
  /** PRD §10.5 — save a dish to user's library. Real persistence WS7.
   *  WS5: log only; returns assigned id. */
  saveDish: (dish: DishDraft) => Promise<{ id: string }>;
  /** PRD §14.9.1 — update user's name. Real persistence WS7. */
  updateUserName: (name: string) => Promise<void>;
  /** PRD §14.9.1 — update user's email. Real flow includes
   *  verification email confirmation. WS5 stub: log only; WS6
   *  wires verification. */
  updateUserEmail: (email: string) => Promise<void>;
  /** PRD §14.9.1 — update user's phone. Real persistence WS7. */
  updateUserPhone: (phone: string) => Promise<void>;
  /** PRD §14.9.2 — update full user preferences. Real persistence WS7. */
  updateUserPreferences: (prefs: UserPreferencesData) => Promise<void>;
  /** PRD §14.9.4 — initiate account deactivation. Real soft-delete +
   *  Stripe cancellation lands in WS7. */
  deactivateAccount: () => Promise<void>;
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
  const [ready, setReady] = useState(false);
  const [prefs, setPrefsState] = useState<UserPrefs>(DEFAULT_PREFS);
  const [plans, setPlans] = useState<MealPlan[]>([]);
  const [currentPlanId, setCurrentPlanIdState] = useState<string | null>(null);
  const [groceries, setGroceries] = useState<GroceryItem[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
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
      const [p, pl, cur, g, fav, prem, ob] = await Promise.all([
        loadJSON<UserPrefs>("prefs", DEFAULT_PREFS),
        loadJSON<MealPlan[]>("plans", []),
        loadJSON<string | null>("currentPlanId", null),
        loadJSON<GroceryItem[]>("groceries", []),
        loadJSON<string[]>("favorites", []),
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
      setFavorites(fav);
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

  const updatePlanName = async (
    planId: string,
    name: string,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /plans/:planId (name)
    console.log("[stub] updatePlanName", { planId, name });
    updateReviewPlanName(planId, name);
  };

  const updatePlanDateRange = async (
    planId: string,
    startDate: string,
    endDate: string,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /plans/:planId (weekStartDate, weekEndDate)
    console.log("[stub] updatePlanDateRange", { planId, startDate, endDate });
    updateReviewPlanDateRange(planId, startDate, endDate);
  };

  const saveDish = async (dish: DishDraft): Promise<{ id: string }> => {
    // TODO(WS7): wire to POST /me/dishes (create) or PATCH /me/dishes/:id (update)
    const id = dish.id ?? `dish-${Date.now()}`;
    console.log("[stub] saveDish", { id, dish });
    return { id };
  };

  const updateUserName = async (name: string): Promise<void> => {
    // TODO(WS7): wire to PATCH /me (name)
    console.log("[stub] updateUserName", { name });
  };

  const updateUserEmail = async (email: string): Promise<void> => {
    // TODO(WS6): wire to verification flow → PATCH /me (email after confirm)
    console.log("[stub] updateUserEmail", { email });
  };

  const updateUserPhone = async (phone: string): Promise<void> => {
    // TODO(WS7): wire to PATCH /me (phone)
    console.log("[stub] updateUserPhone", { phone });
  };

  const updateUserPreferences = async (
    prefs: UserPreferencesData,
  ): Promise<void> => {
    // TODO(WS7): wire to PATCH /me/preferences
    console.log("[AppContext] updateUserPreferences", prefs);
  };

  const deactivateAccount = async (): Promise<void> => {
    // TODO(WS7): wire to POST /me/deactivate (soft-delete + Stripe cancel)
    console.log("[AppContext] deactivateAccount initiated");
  };

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

  const toggleFavorite = useCallback(async (recipeId: string) => {
    // Functional update so rapid taps from any source don't drop toggles.
    let computed: string[] = [];
    setFavorites((prev) => {
      computed = prev.includes(recipeId)
        ? prev.filter((x) => x !== recipeId)
        : [...prev, recipeId];
      return computed;
    });
    await saveJSON("favorites", computed);
  }, []);

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
    setFavorites([]);
    setIsPremiumState(false);
    setOnboardingCompleteState(false);
    setOnboardingStep2DraftState(null);
    setOnboardingStep3DraftState(null);
  }, []);

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
    updateUserEmail,
    updateUserPhone,
    updateUserPreferences,
    deactivateAccount,
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

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

