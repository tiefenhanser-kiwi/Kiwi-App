import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { loadJSON, saveJSON } from "@/lib/storage";
import {
  buildGroceryList,
  defaultPlan,
  getRecipe,
} from "@/lib/stubs";
import type {
  DayOfWeek,
  GroceryItem,
  MealPlan,
  MealSlot,
  RecipeOverride,
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
  groceries: GroceryItem[];
  toggleGrocery: (id: string) => Promise<void>;
  favorites: string[];
  toggleFavorite: (recipeId: string) => Promise<void>;
  isFavorite: (recipeId: string) => boolean;
  isPremium: boolean;
  setPremium: (v: boolean) => Promise<void>;
  onboardingComplete: boolean;
  setOnboardingComplete: (v: boolean) => Promise<void>;
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
    groceries,
    toggleGrocery,
    favorites,
    toggleFavorite,
    isFavorite,
    isPremium,
    setPremium,
    onboardingComplete,
    setOnboardingComplete,
  };

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

