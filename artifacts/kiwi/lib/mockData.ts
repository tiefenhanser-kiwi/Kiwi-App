// Seed data used until the live backend / AI plan generation is wired up.
// All recipe data follows the Recipe schema laid out in Kiwi Deliverable 2.

import { ImageSourcePropType } from "react-native";

export type DayKey = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export const DAYS: DayKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface Ingredient {
  name: string;
  amount: string;
  category: "Produce" | "Protein" | "Dairy" | "Pantry" | "Bakery" | "Frozen";
}

export interface Recipe {
  id: string;
  title: string;
  cuisine: string;
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  image: ImageSourcePropType;
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
}

const meal1 = require("../assets/images/meal-1.png");
const meal2 = require("../assets/images/meal-2.png");
const meal3 = require("../assets/images/meal-3.png");

export const RECIPES: Recipe[] = [
  {
    id: "r-grain-bowl",
    title: "Mediterranean Grain Bowl",
    cuisine: "Mediterranean",
    minutes: 25,
    servings: 2,
    calories: 540,
    protein: 22,
    carbs: 68,
    fat: 18,
    image: meal1,
    tags: ["vegetarian", "high-fiber", "meal-prep"],
    ingredients: [
      { name: "Quinoa", amount: "1 cup", category: "Pantry" },
      { name: "Chickpeas", amount: "1 can", category: "Pantry" },
      { name: "Cherry tomatoes", amount: "1 pint", category: "Produce" },
      { name: "Cucumber", amount: "1", category: "Produce" },
      { name: "Feta", amount: "4 oz", category: "Dairy" },
      { name: "Lemon", amount: "1", category: "Produce" },
      { name: "Olive oil", amount: "3 tbsp", category: "Pantry" },
      { name: "Fresh parsley", amount: "1 bunch", category: "Produce" },
    ],
    steps: [
      "Rinse quinoa and simmer in 2 cups water for 15 minutes.",
      "Drain and rinse chickpeas, then toss with olive oil, salt, and pepper.",
      "Halve cherry tomatoes and dice cucumber.",
      "Whisk lemon juice and olive oil for dressing.",
      "Build bowls: quinoa base, vegetables, chickpeas, crumbled feta.",
      "Drizzle dressing and finish with fresh parsley.",
    ],
  },
  {
    id: "r-salmon",
    title: "Lemon Herb Salmon",
    cuisine: "American",
    minutes: 30,
    servings: 2,
    calories: 620,
    protein: 38,
    carbs: 42,
    fat: 28,
    image: meal2,
    tags: ["pescatarian", "high-protein"],
    ingredients: [
      { name: "Salmon fillets", amount: "2 (6 oz)", category: "Protein" },
      { name: "Wild rice", amount: "1 cup", category: "Pantry" },
      { name: "Asparagus", amount: "1 bunch", category: "Produce" },
      { name: "Lemon", amount: "1", category: "Produce" },
      { name: "Garlic", amount: "3 cloves", category: "Produce" },
      { name: "Olive oil", amount: "2 tbsp", category: "Pantry" },
      { name: "Fresh dill", amount: "1 bunch", category: "Produce" },
    ],
    steps: [
      "Cook wild rice per package, about 40 minutes.",
      "Pat salmon dry and season with salt, pepper, and minced garlic.",
      "Sear salmon skin-side down 4 minutes, flip, cook 3 more.",
      "Roast asparagus at 425°F for 10 minutes with olive oil.",
      "Plate rice, top with salmon, asparagus on the side.",
      "Finish with lemon zest, juice, and fresh dill.",
    ],
  },
  {
    id: "r-stirfry",
    title: "Chicken Veggie Stir-fry",
    cuisine: "Asian",
    minutes: 20,
    servings: 4,
    calories: 480,
    protein: 32,
    carbs: 52,
    fat: 14,
    image: meal3,
    tags: ["high-protein", "kid-friendly", "quick"],
    ingredients: [
      { name: "Chicken breast", amount: "1 lb", category: "Protein" },
      { name: "Broccoli", amount: "1 head", category: "Produce" },
      { name: "Bell peppers", amount: "2", category: "Produce" },
      { name: "Brown rice", amount: "1.5 cups", category: "Pantry" },
      { name: "Soy sauce", amount: "1/4 cup", category: "Pantry" },
      { name: "Ginger", amount: "1 inch", category: "Produce" },
      { name: "Sesame seeds", amount: "2 tbsp", category: "Pantry" },
      { name: "Scallions", amount: "1 bunch", category: "Produce" },
    ],
    steps: [
      "Cook brown rice per package.",
      "Slice chicken into bite-sized strips, season with salt.",
      "Heat oil in wok over high heat. Stir-fry chicken 5 minutes.",
      "Add minced ginger, broccoli florets, sliced peppers.",
      "Stir-fry 4 minutes, add soy sauce.",
      "Plate over rice, top with sesame seeds and scallions.",
    ],
  },
];

export interface MealSlot {
  day: DayKey;
  slot: "Breakfast" | "Lunch" | "Dinner";
  recipeId: string;
}

export interface MealPlan {
  id: string;
  name: string;
  createdAt: number;
  weekStart: string; // ISO date
  meals: MealSlot[];
}

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function defaultPlan(): MealPlan {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const meals: MealSlot[] = [];
  DAYS.forEach((d, i) => {
    meals.push({ day: d, slot: "Dinner", recipeId: RECIPES[i % RECIPES.length].id });
  });
  return {
    id: "plan-current",
    name: "This Week",
    createdAt: Date.now(),
    weekStart: monday.toISOString().slice(0, 10),
    meals,
  };
}

export interface GroceryItem {
  id: string;
  name: string;
  amount: string;
  category: Ingredient["category"];
  checked: boolean;
  inPantry: boolean;
}

export function buildGroceryList(plan: MealPlan): GroceryItem[] {
  const map = new Map<string, GroceryItem>();
  plan.meals.forEach((slot) => {
    const r = getRecipe(slot.recipeId);
    if (!r) return;
    r.ingredients.forEach((ing) => {
      const key = ing.name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          name: ing.name,
          amount: ing.amount,
          category: ing.category,
          checked: false,
          inPantry: false,
        });
      }
    });
  });
  return Array.from(map.values());
}
