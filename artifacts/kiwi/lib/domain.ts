// Pure domain utilities for the Kiwi client.
// Previously colocated with mock recipe data in mockData.ts.

import type { DayAssignment, DayKey, DayOfWeek } from "./types";

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

/** PRD §3.5 — stovetop type single-select. */
export const STOVETOP_TYPES = [
  "Gas",
  "Induction",
  "Electric",
] as const;

/** PRD §3.5 — kid age range checkboxes. */
export const KID_AGE_RANGES = [
  "Toddler (1-3)",
  "Preschool (4-5)",
  "Elementary (6-10)",
  "Tween (11-12)",
  "Teen (13-17)",
] as const;

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

/** PRD §3.5 — spice tolerance single-select. */
export const SPICE_TOLERANCE_OPTIONS = [
  "Mild",
  "Medium",
  "Hot",
  "Very Hot",
] as const;

/** PRD §3.5 — health goal multi-select chips. */
export const HEALTH_GOALS = [
  "Weight loss",
  "Weight maintenance",
  "Weight gain",
  "Muscle building",
  "General health / wellness",
  "Disease management",
] as const;

/** PRD §3.5 — budget level single-select. */
export const BUDGET_LEVELS = [
  "Economy",
  "Mid-range",
  "Premium",
] as const;

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
  "Pet food",
] as const;

/** PRD §3.4 — cooking skill levels. */
export const COOKING_SKILL_LEVELS = [
  "Beginner",
  "Intermediate",
  "Advanced",
] as const;
