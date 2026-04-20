// Seed recipe library used as the candidate set for AI-generated meal plans
// and as fallback content before live integrations land.

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

const img = {
  grain: require("../assets/images/meal-1.png"),
  salmon: require("../assets/images/meal-2.png"),
  stirfry: require("../assets/images/meal-3.png"),
  tacos: require("../assets/images/meal-tacos.png"),
  pasta: require("../assets/images/meal-pasta.png"),
  stew: require("../assets/images/meal-stew.png"),
  tofu: require("../assets/images/meal-tofu.png"),
  pizza: require("../assets/images/meal-pizza.png"),
  curry: require("../assets/images/meal-curry.png"),
  buddha: require("../assets/images/meal-buddha.png"),
  shrimp: require("../assets/images/meal-shrimp.png"),
  greek: require("../assets/images/meal-greek.png"),
};

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
    image: img.grain,
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
    image: img.salmon,
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
      "Sear salmon skin-side down for 4 minutes, flip, cook 3 more.",
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
    image: img.stirfry,
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
      "Heat oil in wok over high heat. Stir-fry chicken for 5 minutes.",
      "Add minced ginger, broccoli florets, and sliced peppers.",
      "Stir-fry for 4 minutes, then add soy sauce.",
      "Plate over rice, top with sesame seeds and scallions.",
    ],
  },
  {
    id: "r-tacos",
    title: "Beef Street Tacos",
    cuisine: "Mexican",
    minutes: 25,
    servings: 4,
    calories: 560,
    protein: 30,
    carbs: 48,
    fat: 24,
    image: img.tacos,
    tags: ["kid-friendly", "quick", "comfort"],
    ingredients: [
      { name: "Ground beef", amount: "1 lb", category: "Protein" },
      { name: "Corn tortillas", amount: "12", category: "Bakery" },
      { name: "White onion", amount: "1", category: "Produce" },
      { name: "Cilantro", amount: "1 bunch", category: "Produce" },
      { name: "Limes", amount: "3", category: "Produce" },
      { name: "Avocado", amount: "2", category: "Produce" },
      { name: "Salsa verde", amount: "1 jar", category: "Pantry" },
      { name: "Cotija cheese", amount: "4 oz", category: "Dairy" },
    ],
    steps: [
      "Brown ground beef in a skillet over medium-high heat for 8 minutes.",
      "Season with cumin, chili powder, salt, and a squeeze of lime.",
      "Char tortillas directly over the burner for 20 seconds per side.",
      "Finely dice onion and chop cilantro for topping.",
      "Slice avocado and cut limes into wedges.",
      "Build tacos: tortilla, beef, onion, cilantro, salsa, cotija.",
    ],
  },
  {
    id: "r-pasta",
    title: "Creamy Mushroom Pasta",
    cuisine: "Italian",
    minutes: 30,
    servings: 4,
    calories: 620,
    protein: 18,
    carbs: 78,
    fat: 26,
    image: img.pasta,
    tags: ["vegetarian", "comfort"],
    ingredients: [
      { name: "Pappardelle", amount: "1 lb", category: "Pantry" },
      { name: "Cremini mushrooms", amount: "1 lb", category: "Produce" },
      { name: "Heavy cream", amount: "1 cup", category: "Dairy" },
      { name: "Parmesan", amount: "1 cup", category: "Dairy" },
      { name: "Garlic", amount: "4 cloves", category: "Produce" },
      { name: "Shallot", amount: "1", category: "Produce" },
      { name: "Fresh thyme", amount: "1 bunch", category: "Produce" },
      { name: "Butter", amount: "3 tbsp", category: "Dairy" },
    ],
    steps: [
      "Bring salted water to a boil; cook pappardelle until al dente.",
      "Slice mushrooms; mince garlic and shallot.",
      "Melt butter in a wide pan, add mushrooms; sear for 6 minutes.",
      "Add shallot and garlic; cook 2 more minutes.",
      "Pour in cream and simmer for 3 minutes; stir in parmesan.",
      "Toss pasta with sauce, finish with thyme and black pepper.",
    ],
  },
  {
    id: "r-stew",
    title: "Hearty Lentil Stew",
    cuisine: "Mediterranean",
    minutes: 45,
    servings: 6,
    calories: 380,
    protein: 18,
    carbs: 56,
    fat: 8,
    image: img.stew,
    tags: ["vegan", "high-fiber", "meal-prep", "budget"],
    ingredients: [
      { name: "Green lentils", amount: "2 cups", category: "Pantry" },
      { name: "Carrots", amount: "3", category: "Produce" },
      { name: "Celery", amount: "3 stalks", category: "Produce" },
      { name: "Yellow onion", amount: "1", category: "Produce" },
      { name: "Diced tomatoes", amount: "1 can", category: "Pantry" },
      { name: "Vegetable broth", amount: "6 cups", category: "Pantry" },
      { name: "Bay leaves", amount: "2", category: "Pantry" },
      { name: "Crusty bread", amount: "1 loaf", category: "Bakery" },
    ],
    steps: [
      "Dice carrots, celery, and onion.",
      "Sauté vegetables in olive oil for 6 minutes until softened.",
      "Add lentils, tomatoes, broth, and bay leaves.",
      "Bring to a boil, then simmer covered for 30 minutes.",
      "Season with salt, pepper, and a splash of red wine vinegar.",
      "Serve with warm crusty bread.",
    ],
  },
  {
    id: "r-tofu",
    title: "Teriyaki Tofu Bowl",
    cuisine: "Asian",
    minutes: 25,
    servings: 2,
    calories: 510,
    protein: 24,
    carbs: 62,
    fat: 18,
    image: img.tofu,
    tags: ["vegan", "high-protein"],
    ingredients: [
      { name: "Extra-firm tofu", amount: "14 oz", category: "Protein" },
      { name: "Brown rice", amount: "1 cup", category: "Pantry" },
      { name: "Edamame", amount: "1 cup", category: "Frozen" },
      { name: "Carrots", amount: "2", category: "Produce" },
      { name: "Teriyaki sauce", amount: "1/3 cup", category: "Pantry" },
      { name: "Sesame oil", amount: "1 tbsp", category: "Pantry" },
      { name: "Sesame seeds", amount: "2 tbsp", category: "Pantry" },
    ],
    steps: [
      "Press tofu for 10 minutes; cube into 1-inch pieces.",
      "Cook brown rice per package directions.",
      "Steam edamame for 5 minutes; shred carrots.",
      "Sear tofu in sesame oil for 8 minutes until golden.",
      "Toss tofu with teriyaki sauce; reduce for 2 minutes.",
      "Build bowls with rice, tofu, edamame, carrots, sesame seeds.",
    ],
  },
  {
    id: "r-pizza",
    title: "Margherita Pizza Night",
    cuisine: "Italian",
    minutes: 35,
    servings: 4,
    calories: 580,
    protein: 22,
    carbs: 68,
    fat: 22,
    image: img.pizza,
    tags: ["vegetarian", "kid-friendly", "comfort"],
    ingredients: [
      { name: "Pizza dough", amount: "1 lb", category: "Bakery" },
      { name: "Fresh mozzarella", amount: "8 oz", category: "Dairy" },
      { name: "San Marzano tomatoes", amount: "1 can", category: "Pantry" },
      { name: "Fresh basil", amount: "1 bunch", category: "Produce" },
      { name: "Olive oil", amount: "2 tbsp", category: "Pantry" },
      { name: "Garlic", amount: "2 cloves", category: "Produce" },
    ],
    steps: [
      "Preheat oven to 500°F with pizza stone for 30 minutes.",
      "Stretch dough into a 12-inch round on parchment.",
      "Crush tomatoes by hand; mix with garlic, salt, olive oil.",
      "Top dough with sauce and torn mozzarella.",
      "Bake for 8 minutes until crust is charred and cheese bubbles.",
      "Finish with fresh basil and a drizzle of olive oil.",
    ],
  },
  {
    id: "r-curry",
    title: "Coconut Chickpea Curry",
    cuisine: "Indian",
    minutes: 30,
    servings: 4,
    calories: 480,
    protein: 16,
    carbs: 62,
    fat: 18,
    image: img.curry,
    tags: ["vegan", "comfort", "meal-prep"],
    ingredients: [
      { name: "Chickpeas", amount: "2 cans", category: "Pantry" },
      { name: "Coconut milk", amount: "1 can", category: "Pantry" },
      { name: "Diced tomatoes", amount: "1 can", category: "Pantry" },
      { name: "Yellow onion", amount: "1", category: "Produce" },
      { name: "Ginger", amount: "2 inches", category: "Produce" },
      { name: "Garam masala", amount: "2 tbsp", category: "Pantry" },
      { name: "Basmati rice", amount: "1.5 cups", category: "Pantry" },
      { name: "Cilantro", amount: "1 bunch", category: "Produce" },
    ],
    steps: [
      "Cook basmati rice per package directions.",
      "Sauté diced onion and ginger in oil for 5 minutes.",
      "Add garam masala and cook for 1 minute until fragrant.",
      "Stir in tomatoes and chickpeas; simmer for 8 minutes.",
      "Pour in coconut milk; simmer 10 more minutes to thicken.",
      "Serve over rice with cilantro and a squeeze of lime.",
    ],
  },
  {
    id: "r-buddha",
    title: "Roasted Veg Buddha Bowl",
    cuisine: "American",
    minutes: 40,
    servings: 2,
    calories: 520,
    protein: 16,
    carbs: 72,
    fat: 18,
    image: img.buddha,
    tags: ["vegan", "high-fiber", "meal-prep"],
    ingredients: [
      { name: "Sweet potato", amount: "1 large", category: "Produce" },
      { name: "Beets", amount: "2", category: "Produce" },
      { name: "Kale", amount: "1 bunch", category: "Produce" },
      { name: "Quinoa", amount: "1 cup", category: "Pantry" },
      { name: "Tahini", amount: "1/4 cup", category: "Pantry" },
      { name: "Lemon", amount: "1", category: "Produce" },
      { name: "Pumpkin seeds", amount: "1/4 cup", category: "Pantry" },
    ],
    steps: [
      "Cube sweet potato and beets; toss with olive oil and salt.",
      "Roast at 425°F for 25 minutes until tender and caramelized.",
      "Cook quinoa in 2 cups water for 15 minutes.",
      "Massage kale with olive oil and lemon juice.",
      "Whisk tahini, lemon juice, and water for dressing.",
      "Build bowls: quinoa, roasted veg, kale; drizzle and seed.",
    ],
  },
  {
    id: "r-shrimp",
    title: "Garlic Shrimp Scampi",
    cuisine: "Italian",
    minutes: 20,
    servings: 4,
    calories: 540,
    protein: 32,
    carbs: 58,
    fat: 18,
    image: img.shrimp,
    tags: ["pescatarian", "quick", "high-protein"],
    ingredients: [
      { name: "Linguine", amount: "1 lb", category: "Pantry" },
      { name: "Large shrimp", amount: "1 lb", category: "Protein" },
      { name: "Garlic", amount: "6 cloves", category: "Produce" },
      { name: "White wine", amount: "1/2 cup", category: "Pantry" },
      { name: "Lemon", amount: "2", category: "Produce" },
      { name: "Butter", amount: "4 tbsp", category: "Dairy" },
      { name: "Parsley", amount: "1 bunch", category: "Produce" },
      { name: "Red pepper flakes", amount: "1 tsp", category: "Pantry" },
    ],
    steps: [
      "Boil salted water; cook linguine until just al dente.",
      "Pat shrimp dry and season with salt and pepper.",
      "Melt butter in a wide pan; add minced garlic for 30 seconds.",
      "Add shrimp; sauté for 3 minutes until pink.",
      "Pour in white wine and lemon juice; reduce for 2 minutes.",
      "Toss with linguine, parsley, and red pepper flakes.",
    ],
  },
  {
    id: "r-greek",
    title: "Big Greek Salad",
    cuisine: "Mediterranean",
    minutes: 15,
    servings: 2,
    calories: 380,
    protein: 12,
    carbs: 22,
    fat: 28,
    image: img.greek,
    tags: ["vegetarian", "quick", "light"],
    ingredients: [
      { name: "Tomatoes", amount: "4", category: "Produce" },
      { name: "Cucumber", amount: "1", category: "Produce" },
      { name: "Red onion", amount: "1/2", category: "Produce" },
      { name: "Kalamata olives", amount: "1 cup", category: "Pantry" },
      { name: "Feta block", amount: "6 oz", category: "Dairy" },
      { name: "Olive oil", amount: "1/4 cup", category: "Pantry" },
      { name: "Red wine vinegar", amount: "2 tbsp", category: "Pantry" },
      { name: "Dried oregano", amount: "1 tbsp", category: "Pantry" },
    ],
    steps: [
      "Cut tomatoes into chunky wedges.",
      "Slice cucumber into thick half-moons.",
      "Thinly slice red onion; soak in cold water for 5 minutes.",
      "Combine vegetables and olives in a wide bowl.",
      "Whisk olive oil, vinegar, and oregano; toss with salad.",
      "Top with a slab of feta and a generous crack of pepper.",
    ],
  },
];

export interface MealSlot {
  day: DayKey;
  slot: "Breakfast" | "Lunch" | "Dinner";
  recipeId: string;
  reason?: string;
}

export interface MealPlan {
  id: string;
  name: string;
  notes?: string;
  createdAt: number;
  weekStart: string;
  meals: MealSlot[];
}

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function getMondayISO(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function defaultPlan(): MealPlan {
  const meals: MealSlot[] = DAYS.map((d, i) => ({
    day: d,
    slot: "Dinner",
    recipeId: RECIPES[i % RECIPES.length].id,
  }));
  return {
    id: "plan-current",
    name: "This Week",
    createdAt: Date.now(),
    weekStart: getMondayISO(),
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

export function buildGroceryList(
  plan: MealPlan,
  pantry: string[] = [],
): GroceryItem[] {
  const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
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
          inPantry: pantrySet.has(key),
        });
      }
    });
  });
  return Array.from(map.values());
}

