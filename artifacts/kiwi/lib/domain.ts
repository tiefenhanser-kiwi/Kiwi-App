// Pure domain utilities for the Kiwi client.
// Previously colocated with mock recipe data in mockData.ts.

import type {
  DayAssignment,
  DayKey,
  DayOfWeek,
  GroceryListItem,
  Subscription,
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
      // WS9-2 2a — a genuinely-past trial floors to 0 days; surface "Trial ended"
      // rather than the technically-true-but-broken-looking "Trial · 0 days
      // remaining". A null trialEndsAt arrives here as undefined (see
      // subscriptionInfoFromAuth) → plain "Trial", never "ended".
      if (sub.trialDaysRemaining == null) return "Trial";
      return sub.trialDaysRemaining <= 0
        ? "Trial ended"
        : `Trial · ${sub.trialDaysRemaining} days remaining`;
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

// WS9-2 — free-trial length in days. Single source for the mobile copy surfaces
// (TrialBadge + the sign-up trust signal). Ruled 14 (the business-plan economics
// are modeled on 14, not the prior 30).
// ⚠️ KEEP IN SYNC with the server stamp: artifacts/api-server/src/routes/auth.ts
// has its own `TRIAL_LENGTH_DAYS` (separate package, no cheap shared module).
// Change BOTH together — this const only drives copy; the server one sets the
// actual trialEndsAt.
export const TRIAL_LENGTH_DAYS = 14;

// WS9-2 BUG-072 — days left in a trial: ceil((trialEndsAt - now) / day), floored
// at 0. Single source of the computation TrialBadge (components/TrialBadge.tsx)
// and the Profile / Manage-Account subscription line both read, so a trial-length
// change lands everywhere at once.
export function trialDaysRemaining(
  trialEndsAt: string | null | undefined,
): number {
  if (!trialEndsAt) return 0;
  const msLeft = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
}

// WS9-2 BUG-072 — map the real DB-backed Subscription (AuthContext.user.
// subscription) into the SubscriptionInfo shape formatSubscriptionState renders.
// The status names differ: server "trialing" -> UI tier "trial". Renewal date is
// the ISO currentPeriodEnd, formatted for display; the trial day count is
// computed (never hardcoded) via trialDaysRemaining.
export function subscriptionInfoFromAuth(
  sub: Subscription | null | undefined,
): SubscriptionInfo {
  if (!sub) return { tier: "none" };
  const tier: SubscriptionInfo["tier"] =
    sub.status === "trialing"
      ? "trial"
      : sub.status === "active"
        ? "active"
        : sub.status === "past_due"
          ? "past_due"
          : sub.status === "canceled"
            ? "canceled"
            : "none";
  return {
    tier,
    // WS9-2 2a — only a REAL trialEndsAt yields a day count. A null date must
    // stay undefined (→ plain "Trial"), NOT floor to 0, so formatSubscriptionState
    // can't misread it as "Trial ended". A genuine past date floors to 0 → ended.
    trialDaysRemaining:
      tier === "trial" && sub.trialEndsAt != null
        ? trialDaysRemaining(sub.trialEndsAt)
        : undefined,
    nextRenewalDate: sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : undefined,
  };
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
