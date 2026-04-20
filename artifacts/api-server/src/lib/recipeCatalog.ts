// Server-side authoritative recipe catalog. The mobile client may render
// a richer view of the same recipes, but the AI plan generator only ever
// sees these IDs / metadata — preventing catalog-id smuggling.

export interface ServerRecipe {
  id: string;
  title: string;
  cuisine: string;
  minutes: number;
  tags: string[];
}

export const SERVER_RECIPES: ServerRecipe[] = [
  { id: "r-grain-bowl", title: "Mediterranean Grain Bowl", cuisine: "Mediterranean", minutes: 25, tags: ["vegetarian", "high-fiber", "meal-prep"] },
  { id: "r-salmon", title: "Lemon Herb Salmon", cuisine: "American", minutes: 30, tags: ["pescatarian", "high-protein"] },
  { id: "r-stirfry", title: "Chicken Veggie Stir-fry", cuisine: "Asian", minutes: 20, tags: ["high-protein", "kid-friendly", "quick"] },
  { id: "r-tacos", title: "Beef Street Tacos", cuisine: "Mexican", minutes: 25, tags: ["kid-friendly", "quick", "comfort"] },
  { id: "r-pasta", title: "Creamy Mushroom Pasta", cuisine: "Italian", minutes: 30, tags: ["vegetarian", "comfort"] },
  { id: "r-stew", title: "Hearty Lentil Stew", cuisine: "Mediterranean", minutes: 45, tags: ["vegan", "high-fiber", "meal-prep", "budget"] },
  { id: "r-tofu", title: "Teriyaki Tofu Bowl", cuisine: "Asian", minutes: 25, tags: ["vegan", "high-protein"] },
  { id: "r-pizza", title: "Margherita Pizza Night", cuisine: "Italian", minutes: 35, tags: ["vegetarian", "kid-friendly", "comfort"] },
  { id: "r-curry", title: "Coconut Chickpea Curry", cuisine: "Indian", minutes: 30, tags: ["vegan", "comfort", "meal-prep"] },
  { id: "r-buddha", title: "Roasted Veg Buddha Bowl", cuisine: "American", minutes: 40, tags: ["vegan", "high-fiber", "meal-prep"] },
  { id: "r-shrimp", title: "Garlic Shrimp Scampi", cuisine: "Italian", minutes: 20, tags: ["pescatarian", "quick", "high-protein"] },
  { id: "r-greek", title: "Big Greek Salad", cuisine: "Mediterranean", minutes: 15, tags: ["vegetarian", "quick", "light"] },
];

export const SERVER_RECIPE_IDS = new Set(SERVER_RECIPES.map((r) => r.id));
