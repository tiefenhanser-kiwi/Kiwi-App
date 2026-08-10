// TEMPORARY STUBS — Will be replaced by API calls in WS7.
//
// WS1 removed the hardcoded RECIPES data source (mockData.ts). These
// stubs kept the build green while Home (WS3), meal swap (WS5), and
// API client (WS7) were rebuilt against the new Prisma-backed endpoints.
//
// WS9-2 Block 2a Commit 8 — the meal/dish/plan/subscription/user fixtures were
// deleted once every consumer moved to the real API (BUG-070/072/073/078 wired
// the last few). What remains is the legacy AsyncStorage local-plan scaffold
// (defaultPlan + buildGroceryList, still called by AppContext's boot effect)
// and the design-review-only grocery fixture (getGroceryListById, resolved for
// "demo-grocery-*" ids by grocery-list/[id].tsx; real lists use the API).

import type { GroceryItem, GroceryList, MealPlan } from "./types";
import { DAYS, getMondayISO } from "./domain";

// Returns an empty plan scaffold. AppContext uses this on fresh install
// when there are no saved plans. Empty plan = empty UI state (correct
// behavior until WS3 builds the real Home flow).
export function defaultPlan(): MealPlan {
  return {
    id: "plan-current",
    name: "This Week",
    createdAt: Date.now(),
    weekStart: getMondayISO(),
    meals: DAYS.map((d) => ({
      day: d,
      slot: "Dinner",
      recipeId: "",
    })),
  };
}

// Returns empty grocery list until WS7 wires the real derivation.
export function buildGroceryList(_plan: MealPlan): GroceryItem[] {
  return [];
}

// ── Grocery system (PRD §12) ──

// getGroceryLists retired in WS7-3 C3 c4 — the Groceries tab now reads the
// real GET /grocery-lists via useGroceryLists(). The single-list fixture
// (getGroceryListById, below) stays until grocery-list/[id].tsx migrates.

/**
 * PRD §12.6 — full grocery list by id.
 * For WS5 demo: returns hardcoded list per id.
 */
export function getGroceryListById(id: string): GroceryList | null {
  if (id === "demo-grocery-1") {
    return {
      id: "demo-grocery-1",
      planName: "Family Friendly Healthy Meals",
      planId: "demo-plan-this-week",
      status: "active",
      createdAt: new Date().toISOString(),
      isThisWeek: true,
      ambiguousItemCount: 3, // matches prototype "Review 3 flagged items"
      items: [
        // Produce
        { id: "g1-1", name: "Romaine lettuce", quantity: "2 heads", quantityAmount: "2", quantityUnit: "heads", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-2", name: "Tomatoes", quantity: "4 large", quantityAmount: "4", quantityUnit: "large", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-3", name: "Yellow onion", quantity: "3", quantityAmount: "3", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-4", name: "Avocados", quantity: "2", quantityAmount: "2", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-5", name: "Limes", quantity: "4", quantityAmount: "4", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-6", name: "Russet potatoes", quantity: "2 lbs", quantityAmount: "2", quantityUnit: "lbs", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        // Meat & Seafood
        { id: "g1-7", name: "Ground beef (80/20)", quantity: "2 lbs", quantityAmount: "2", quantityUnit: "lbs", sectionKey: "meat_seafood", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-8", name: "Chicken breasts", quantity: "3 lbs", quantityAmount: "3", quantityUnit: "lbs", sectionKey: "meat_seafood", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-9", name: "Hot dogs", quantity: "1 pack", quantityAmount: "1", quantityUnit: "pack", sectionKey: "meat_seafood", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        // Dairy & Eggs
        { id: "g1-10", name: "Shredded cheddar", quantity: "8 oz", quantityAmount: "8", quantityUnit: "oz", sectionKey: "dairy_eggs", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-11", name: "Parmesan", quantity: "4 oz", quantityAmount: "4", quantityUnit: "oz", sectionKey: "dairy_eggs", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: true, isCompleted: false },
        { id: "g1-12", name: "Milk", quantity: "1 gallon", quantityAmount: "1", quantityUnit: "gallon", sectionKey: "dairy_eggs", isUniversalStaple: false, isRecurringItem: true, isAmbiguous: false, isOptional: false, isCompleted: false },
        // Bakery & Bread
        { id: "g1-13", name: "Burger buns", quantity: "8 ct", quantityAmount: "8", quantityUnit: "ct", sectionKey: "bakery_bread", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        // Pantry
        { id: "g1-14", name: "Taco shells", quantity: "1 box", quantityAmount: "1", quantityUnit: "box", sectionKey: "pantry", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-15", name: "Caesar dressing", quantity: "1 bottle", quantityAmount: "1", quantityUnit: "bottle", sectionKey: "pantry", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: true, isCompleted: false },
        // Pantry staples (greyed out, default unselected) — leave structured
        // fields undefined per WS5-5Q-fix-2: "—" is ambiguous; once the user
        // opts in and edits a quantity, the structured fields populate.
        { id: "g1-16", name: "Salt", quantity: "—", sectionKey: "pantry", isUniversalStaple: true, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-17", name: "Black pepper", quantity: "—", sectionKey: "pantry", isUniversalStaple: true, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-18", name: "Olive oil", quantity: "—", sectionKey: "pantry", isUniversalStaple: true, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-19", name: "Butter", quantity: "—", sectionKey: "pantry", isUniversalStaple: true, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
        { id: "g1-20", name: "Garlic", quantity: "—", sectionKey: "pantry", isUniversalStaple: true, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: false },
      ],
    };
  }

  // Shorter lists for the other 2 demo entries (just enough to render)
  if (id === "demo-grocery-2") {
    return {
      id: "demo-grocery-2",
      planName: "Whole30 January Reset",
      status: "completed",
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      isThisWeek: false,
      ambiguousItemCount: 0,
      items: [
        { id: "g2-1", name: "Sweet potatoes", quantity: "3 lbs", quantityAmount: "3", quantityUnit: "lbs", sectionKey: "produce", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: true },
        { id: "g2-2", name: "Eggs", quantity: "2 dozen", quantityAmount: "2", quantityUnit: "dozen", sectionKey: "dairy_eggs", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: true },
        { id: "g2-3", name: "Almonds", quantity: "1 lb", quantityAmount: "1", quantityUnit: "lb", sectionKey: "snacks", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: true },
      ],
    };
  }

  if (id === "demo-grocery-3") {
    return {
      id: "demo-grocery-3",
      planName: "4th of July BBQ",
      status: "completed",
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      isThisWeek: false,
      ambiguousItemCount: 0,
      items: [
        { id: "g3-1", name: "Hamburger patties", quantity: "10 ct", quantityAmount: "10", quantityUnit: "ct", sectionKey: "meat_seafood", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: true },
        { id: "g3-2", name: "Brioche buns", quantity: "10 ct", quantityAmount: "10", quantityUnit: "ct", sectionKey: "bakery_bread", isUniversalStaple: false, isRecurringItem: false, isAmbiguous: false, isOptional: false, isCompleted: true },
      ],
    };
  }

  return null;
}
