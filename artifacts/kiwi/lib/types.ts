// Shared domain types for the Kiwi client.
// Previously colocated with mock recipe data in mockData.ts; extracted
// during WS1 so types can outlive the mock data layer.

export type DayKey = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

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
  image: any; // ImageSourcePropType from react-native — typed loosely to avoid pulling RN types into lib
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
}

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

export interface GroceryItem {
  id: string;
  name: string;
  amount: string;
  category: Ingredient["category"];
  checked: boolean;
  inPantry: boolean;
}

export type Subscription = {
  status: "trialing" | "active" | "past_due" | "canceled" | "none";
  planCode: "free" | "premium_monthly" | "premium_annual";
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
};

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: string;
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  subscription: Subscription | null;
  createdAt: string;
}
