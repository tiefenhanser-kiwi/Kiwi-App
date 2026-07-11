// Pure domain utilities for the Kiwi client.
// Previously colocated with mock recipe data in mockData.ts.

import type {
  DayAssignment,
  DayKey,
  DayOfWeek,
  GroceryListItem,
  SubscriptionInfo,
} from "./types";

export const DAYS: DayKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** PRD §2.4 Sunday-Saturday day-strip order, used by Plan Review rows. */
export const DAY_OF_WEEK_ORDER: DayOfWeek[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Build a 7-pill day strip with at most one pill marked assigned.
 * Pass `null` to produce an empty (all-unassigned) strip — used when
 * a meal lands in the unscheduled cluster.
 */
export function buildDayStrip(
  assignedDay: DayOfWeek | null,
): DayAssignment[] {
  return DAY_OF_WEEK_ORDER.map((day) => ({
    day,
    isAssigned: assignedDay === day,
  }));
}

export function getMondayISO(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────
// PRD §3.4 / §5.3 — wizard preference catalogs
// ─────────────────────────────────────────────────────────────────

/** PRD §3.4 — 8 tier-1 cuisines (always visible). */
export const CUISINES_TIER_1 = [
  "American",
  "Italian",
  "Mexican",
  "Asian",
  "Mediterranean",
  "Indian",
  "Comfort Food",
  "BBQ/Grill",
] as const;

/** PRD §3.4 — 16 tier-2 cuisines (expandable). */
export const CUISINES_TIER_2 = [
  "Chinese",
  "Japanese",
  "Thai",
  "Vietnamese",
  "Korean",
  "Middle Eastern",
  "French",
  "Spanish",
  "Greek",
  "Caribbean",
  "African",
  "Cajun/Creole",
  "Tex-Mex",
  "Latin American",
  "Soul Food",
  "Brazilian",
] as const;

/** PRD §3.4 — 14 eating styles (always visible inside diet section). */
export const EATING_STYLES = [
  "Vegetarian",
  "Vegan",
  "Pescatarian",
  "Keto",
  "Paleo",
  "Whole30",
  "Mediterranean diet",
  "Low-carb",
  "Low-fat",
  "High-protein",
  "High-fiber",
  "Diabetic-friendly",
  "Heart-healthy",
  "Healthy",
] as const;

/** PRD §3.4 — 11 allergies and avoidances (expandable subgroup). */
export const ALLERGIES_AND_AVOIDANCES = [
  "Dairy-free",
  "Gluten-free",
  "Nut-free",
  "Peanut-free",
  "Tree-nut-free",
  "Shellfish-free",
  "Egg-free",
  "Soy-free",
  "Wheat-free",
  "Sesame-free",
  "Fish-free",
] as const;

/** Plan duration presets per Hans — single-select 1-7 days. */
export const PLAN_DURATION_PRESETS = [1, 2, 3, 4, 5, 6, 7] as const;

// ── Cookbook Phase B, Block 3 — preference-control option sets ──────────────
// Rendered as Chip rows (shared skill/spice vocabulary — no segmented widget).
// { label, value } tuples so a chip can carry a null / non-string value.

/** Cook-time cap chips. `null` = no limit (the field is nullable). */
export const COOK_TIME_CAP_OPTIONS: ReadonlyArray<{
  label: string;
  value: number | null;
}> = [
  { label: "No limit", value: null },
  { label: "30 min", value: 30 },
  { label: "45 min", value: 45 },
  { label: "60 min", value: 60 },
];

/** Cook-time coverage — only meaningful when a cap is set. Default "most". */
export const COOK_TIME_COVERAGE_OPTIONS: ReadonlyArray<{
  label: string;
  value: "most" | "all";
}> = [
  { label: "Most nights", value: "most" },
  { label: "Every night", value: "all" },
];

/** Discovery meals per week — 0 (Off) | 1 | 2. Default 0. */
export const DISCOVERY_MEALS_OPTIONS: ReadonlyArray<{
  label: string;
  value: number;
}> = [
  { label: "Off", value: 0 },
  { label: "1", value: 1 },
  { label: "2", value: 2 },
];

/** Sauce preference — three-way single-select. Default "balanced". */
export const SAUCE_PREFERENCE_OPTIONS: ReadonlyArray<{
  label: string;
  value: "homemade" | "balanced" | "store_bought";
}> = [
  { label: "From scratch preferred", value: "homemade" },
  { label: "Balanced", value: "balanced" },
  { label: "Store-bought preferred", value: "store_bought" },
];

/**
 * PRD §14.7 — display-friendly subscription state line.
 * Shared by Profile (card body) and /manage-account (header).
 */
export function formatSubscriptionState(sub: SubscriptionInfo): string {
  switch (sub.tier) {
    case "trial":
      return sub.trialDaysRemaining != null
        ? `Trial · ${sub.trialDaysRemaining} days remaining`
        : "Trial";
    case "active":
      return sub.nextRenewalDate
        ? `Active · renews ${sub.nextRenewalDate}`
        : "Active";
    case "past_due":
      return "Past due — please update billing";
    case "canceled":
      return "Canceled";
    case "none":
    default:
      return "No active subscription";
  }
}

/** PRD §3.5 — cooking equipment chips (multi-select). */
export const COOKING_EQUIPMENT = [
  "Stove",
  "Oven",
  "Microwave",
  "Toaster oven",
  "Air fryer",
  "Slow cooker",
  "Pressure cooker",
  "Sous vide",
  "Outdoor grill — Gas",
  "Outdoor grill — Charcoal",
  "Smoker",
  "Stand mixer",
  "Food processor",
  "Blender",
  "High-powered blender",
  "Cast iron skillet",
  "Dutch oven",
  "Wok",
] as const;

/** PRD §3.5 — stovetop type single-select (canonical server values). */
export const STOVETOP_TYPES = ["gas", "induction", "electric"] as const;

/** Display labels for STOVETOP_TYPES — UI renders these; wire uses canonical. */
export const STOVETOP_TYPE_LABELS: Record<
  (typeof STOVETOP_TYPES)[number],
  string
> = {
  gas: "Gas",
  induction: "Induction",
  electric: "Electric",
};

/** PRD §3.5 — picky eater avoidance chips. */
export const PICKY_AVOIDANCES = [
  "Mushrooms",
  "Fish",
  "Spicy food",
  "Strong cheese",
  "Onions",
  "Olives",
  "Nuts",
  "Vegetables (broadly)",
  "Seafood",
] as const;

/** PRD §3.5 — spice tolerance single-select (canonical server values). */
export const SPICE_TOLERANCE_OPTIONS = [
  "mild",
  "medium",
  "hot",
  "very_hot",
] as const;

/** Display labels for SPICE_TOLERANCE_OPTIONS — UI renders these. */
export const SPICE_TOLERANCE_LABELS: Record<
  (typeof SPICE_TOLERANCE_OPTIONS)[number],
  string
> = {
  mild: "Mild",
  medium: "Medium",
  hot: "Hot",
  very_hot: "Very Hot",
};

/** PRD §3.5 — health goal multi-select chips. */
export const HEALTH_GOALS = [
  "Weight loss",
  "Weight maintenance",
  "Weight gain",
  "Muscle building",
  "General health / wellness",
  "Disease management",
] as const;

/** PRD §3.5 — budget level single-select (canonical server values). */
export const BUDGET_LEVELS = ["economy", "mid_range", "premium"] as const;

/** Display labels for BUDGET_LEVELS — UI renders these. */
export const BUDGET_LEVEL_LABELS: Record<
  (typeof BUDGET_LEVELS)[number],
  string
> = {
  economy: "Economy",
  mid_range: "Mid-range",
  premium: "Premium",
};

/** PRD §14.9.2 — default retailer single-select. */
export const DEFAULT_RETAILERS = [
  "Instacart",
  "Amazon Fresh",
  "Walmart",
  "Kroger",
  "Other",
] as const;

/** PRD §3.4 — common recurring grocery item suggestions. */
export const COMMON_RECURRING_ITEMS = [
  "Toilet paper",
  "Paper towels",
  "Milk",
  "Eggs",
  "Bananas",
  "Bread",
  "Coffee",
  "Pet treats",
] as const;

/** PRD §3.4 — cooking skill levels (canonical server values). */
export const COOKING_SKILL_LEVELS = [
  "beginner",
  "intermediate",
  "advanced",
] as const;

/** Display labels for COOKING_SKILL_LEVELS — UI renders these. */
export const COOKING_SKILL_LABELS: Record<
  (typeof COOKING_SKILL_LEVELS)[number],
  string
> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

/**
 * PRD §12.4 — grocery section display order + display labels.
 */
export const GROCERY_SECTIONS: Array<{
  key: GroceryListItem["sectionKey"];
  label: string;
}> = [
  { key: "produce", label: "Produce" },
  { key: "meat_seafood", label: "Meat & Seafood" },
  { key: "dairy_eggs", label: "Dairy & Eggs" },
  { key: "bakery_bread", label: "Bakery & Bread" },
  { key: "pantry", label: "Pantry" },
  { key: "canned", label: "Canned" },
  { key: "frozen", label: "Frozen" },
  { key: "snacks", label: "Snacks" },
  { key: "household", label: "Household" },
  { key: "extras", label: "Extras" },
];
