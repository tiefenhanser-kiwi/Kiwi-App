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
  GroceryItem,
  MealPlan,
  MealSlot,
  RECIPES,
} from "@/lib/mockData";

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
  groceries: GroceryItem[];
  toggleGrocery: (id: string) => Promise<void>;
  togglePantry: (id: string) => Promise<void>;
  addPantryItem: (name: string) => Promise<void>;
  removePantryItem: (name: string) => Promise<void>;
  pantry: string[];
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
  const [pantry, setPantry] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [isPremium, setIsPremiumState] = useState(false);
  const [onboardingComplete, setOnboardingCompleteState] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, pl, cur, g, pan, fav, prem, ob] = await Promise.all([
        loadJSON<UserPrefs>("prefs", DEFAULT_PREFS),
        loadJSON<MealPlan[]>("plans", []),
        loadJSON<string | null>("currentPlanId", null),
        loadJSON<GroceryItem[]>("groceries", []),
        loadJSON<string[]>("pantry", []),
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
          groceriesToUse = buildGroceryList(cp, pan);
          await saveJSON("groceries", groceriesToUse);
        }
      } else if (groceriesToUse.length > 0) {
        // Reconcile inPantry flags against the persisted pantry so the
        // two stores never drift out of sync after schema changes.
        const pantrySet = new Set(pan.map((x) => x.toLowerCase()));
        const reconciled = groceriesToUse.map((row) => ({
          ...row,
          inPantry: pantrySet.has(row.name.toLowerCase()),
        }));
        const drift = reconciled.some(
          (r, i) => r.inPantry !== groceriesToUse[i].inPantry,
        );
        if (drift) {
          groceriesToUse = reconciled;
          await saveJSON("groceries", groceriesToUse);
        }
      }
      setPlans(plansToUse);
      setCurrentPlanIdState(curId);
      setGroceries(groceriesToUse);
      setPantry(pan);
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
    async (plan: MealPlan, currentPantry: string[]) => {
      const ng = buildGroceryList(plan, currentPantry);
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
      await persistGroceriesFor(plan, pantry);
    },
    [plans, pantry, persistGroceriesFor],
  );

  const setCurrentPlan = useCallback(
    async (id: string) => {
      setCurrentPlanIdState(id);
      await saveJSON("currentPlanId", id);
      const plan = plans.find((p) => p.id === id);
      if (plan) await persistGroceriesFor(plan, pantry);
    },
    [plans, pantry, persistGroceriesFor],
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
      await persistGroceriesFor(updatedPlan, pantry);
    },
    [plans, currentPlanId, pantry, persistGroceriesFor],
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

  const togglePantry = useCallback(
    async (id: string) => {
      const target = groceries.find((g) => g.id === id);
      if (!target) return;
      const nextInPantry = !target.inPantry;
      const updatedGroceries = groceries.map((g) =>
        g.id === id ? { ...g, inPantry: nextInPantry } : g,
      );
      setGroceries(updatedGroceries);

      // Surgically add/remove this single item — never rebuild pantry from
      // groceries alone (would silently drop manually added pantry items).
      const lower = target.name.toLowerCase();
      let newPantry: string[];
      if (nextInPantry) {
        newPantry = pantry.some((p) => p.toLowerCase() === lower)
          ? pantry
          : [...pantry, target.name];
      } else {
        newPantry = pantry.filter((p) => p.toLowerCase() !== lower);
      }
      setPantry(newPantry);
      await Promise.all([
        saveJSON("groceries", updatedGroceries),
        saveJSON("pantry", newPantry),
      ]);
    },
    [groceries, pantry],
  );

  const addPantryItem = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (pantry.some((p) => p.toLowerCase() === trimmed.toLowerCase())) return;
      const newPantry = [...pantry, trimmed];
      setPantry(newPantry);
      await saveJSON("pantry", newPantry);
      const updatedGroceries = groceries.map((g) =>
        g.name.toLowerCase() === trimmed.toLowerCase()
          ? { ...g, inPantry: true }
          : g,
      );
      setGroceries(updatedGroceries);
      await saveJSON("groceries", updatedGroceries);
    },
    [pantry, groceries],
  );

  const removePantryItem = useCallback(
    async (name: string) => {
      const newPantry = pantry.filter(
        (p) => p.toLowerCase() !== name.toLowerCase(),
      );
      setPantry(newPantry);
      await saveJSON("pantry", newPantry);
      const updatedGroceries = groceries.map((g) =>
        g.name.toLowerCase() === name.toLowerCase()
          ? { ...g, inPantry: false }
          : g,
      );
      setGroceries(updatedGroceries);
      await saveJSON("groceries", updatedGroceries);
    },
    [pantry, groceries],
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
    groceries,
    toggleGrocery,
    togglePantry,
    addPantryItem,
    removePantryItem,
    pantry,
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

export const ALL_RECIPE_IDS = RECIPES.map((r) => r.id);
