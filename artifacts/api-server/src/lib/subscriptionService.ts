// Stub for SubscriptionService.can() per PRD §14.5.
// Real billing-state resolution lands in the Stripe phase (deferred per
// kiwi_ws6_plan.md §7). During WS6, all features return allowed: true —
// every user is in the 30-day trial.

export type EntitlementKey =
  | "kitchen_wizard_set_preferences"
  | "kitchen_wizard_just_say"
  | "kitchen_wizard_cook_what_i_have_now"
  | "meal_builder_text_input"
  | "kitchen_wizard_one_meal"
  | "prep_the_week_orchestrated"
  | "grocery_ordering"
  | "unlimited_plans"
  | "ad_free"
  | "find_similar_ai";

export interface EntitlementResult {
  allowed: boolean;
  reason?: string;
}

export interface SubscriptionService {
  can(userId: string, feature: EntitlementKey): Promise<EntitlementResult>;
}

export const subscriptionService: SubscriptionService = {
  async can(_userId, _feature) {
    // TODO(stripe-phase): replace with real billing-state resolution per PRD
    // §14.5.2. For WS6: trial-mode fallthrough — everyone allowed.
    return { allowed: true };
  },
};
