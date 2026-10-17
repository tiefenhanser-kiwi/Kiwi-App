import React from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { DisplayTitle, resolveDisplayTitle } from "@/components/DisplayTitle";
import { Header } from "@/components/Header";
import { SectionLabel } from "@/components/SectionLabel";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Radius, Spacing, Typography } from "@/constants/tokens";
import { useDish } from "@/hooks/useDish";
import { useMeal } from "@/hooks/useMeal";
import { buildAmountRefSegments } from "@/lib/cooking/amountSegments";
import { decodeRun, makeAheadRunSteps, runCookLine, type MakeAheadRun } from "@/lib/cooking/feastDay";
import { planDishView, type PlanDishView } from "@/lib/dishes/planDish";
import { ApiError } from "@/lib/api/errors";
import type { DishDetail } from "@/lib/api/dishes";
import { BillingNotice } from "@/components/BillingNotice";
import { useBilling } from "@/contexts/BillingContext";
import { macrosNoticeFor } from "@/lib/billing/subscriptionView";
import { formatMacro } from "@/lib/format/macros";
import { formatIngredientLine } from "@/lib/format/ingredientLine";
import { goBack } from "@/lib/navigation";

// WS7-3 Block C3 c3: dish detail reads GET /dishes/:id via useDish. Adopts
// the Block B gate/body pattern from app/meal/[id].tsx — DishDetailScreen
// handles the read state machine; DishDetailContent renders the loaded body.
//
// D-WS7-050 (RULED 2026-08-02 — ratify the LEAN dish shape): this screen
// intentionally renders NO Main/Side type pill, NO Notes section, and NO
// cuisine in the meta line. The Dish model has no `type`/`notes`/`cuisineType`
// columns and none are being added, so there is nothing to restore — the lean
// shape (description + real `servings`) IS the shape. The prior "field loss"
// framing is retired.
//
// PREP-2 item 2 — PLAN CONTEXT. A Thanksgiving make-ahead row opens its dish with
// `mealId` (the feast), `planId` + `planItemId` and `run` (the row's day). The
// recipe body — ingredients, steps, servings — then comes from the composed MEAL
// in plan context and scales the way meal detail scales (lib/dishes/planDish.ts);
// GET /dishes/:id still supplies the hero. Cook Now opens that one run. Without
// `mealId` the screen is exactly what it was.
export default function DishDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    mealId?: string;
    planId?: string;
    planItemId?: string;
    run?: string;
  }>();
  const dishId = params.id ?? "";
  const mealId = typeof params.mealId === "string" ? params.mealId : "";
  const planId = typeof params.planId === "string" ? params.planId : "";
  const planItemId = typeof params.planItemId === "string" ? params.planItemId : "";

  const dishQuery = useDish(dishId);
  // Disabled (empty id) on every launch without plan context.
  const mealQuery = useMeal(mealId, planItemId || undefined);

  if (dishQuery.isLoading || (mealId.length > 0 && mealQuery.isLoading)) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Dish" showBack />
        <View style={s.gateWrap}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      </View>
    );
  }

  const dish = dishQuery.data;
  if (!dish) {
    const err = dishQuery.error;
    const isNotFound =
      dishId === "" || (err instanceof ApiError && err.status === 404);
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Dish" showBack />
        <View style={s.gateWrap}>
          <Text style={s.gateText}>
            {isNotFound
              ? "Dish not found."
              : "Couldn't load this dish. Please try again."}
          </Text>
          <View style={s.gateBtnWrap}>
            {isNotFound ? (
              <Button
                label="Go back"
                variant="ghost"
                onPress={() => goBack(router)}
              />
            ) : (
              <Button
                label="Try again"
                variant="primary"
                onPress={() => dishQuery.refetch()}
              />
            )}
          </View>
        </View>
      </View>
    );
  }

  // PREP-2 — a meal that no longer holds the dish (or failed to load) falls back to
  // the dish alone rather than to an error: the recipe is still worth showing.
  const view = mealId.length > 0 && mealQuery.data ? planDishView(mealQuery.data, dish.id) : null;
  const plan: PlanDishContext | undefined = view
    ? {
        view,
        run: decodeRun(typeof params.run === "string" ? params.run : undefined),
        cookParams: {
          mealId,
          dishId: dish.id,
          ...(typeof params.run === "string" ? { run: params.run } : {}),
          ...(planId && planItemId ? { planId, planItemId } : {}),
        },
      }
    : undefined;

  return <DishDetailContent dish={dish} plan={plan} />;
}

interface PlanDishContext {
  view: PlanDishView;
  run: MakeAheadRun | null;
  /** Cook Mode for this dish of the meal, in plan context, narrowed to `run`. */
  cookParams: Record<string, string>;
}

function DishDetailContent({ dish, plan }: { dish: DishDetail; plan?: PlanDishContext }) {
  const router = useRouter();
  // Row 9 (1.1) Stripe S2 Part E -- above every early return, per the block rule.
  const { subscription } = useBilling();

  const onCookNow = () => {
    console.log("[dish-detail] cook-now tapped", { dishId: dish.id });
    // PREP-2 — in plan context Cook Mode reads the dish out of the meal (scaled,
    // one run); otherwise the dish alone, as before.
    if (plan) {
      router.push({ pathname: "/cook-session", params: plan.cookParams });
      return;
    }
    // WS7-8b B2 — meal-context "Cook Now" → temporary /cook-session stub (the
    // Hub took over /prep-cook). Block 3 owns the real single-meal Cook session.
    router.push({ pathname: "/cook-session", params: { dishId: dish.id } });
  };
  // PREP-2 — what this screen lists: the plan's copy of the dish, or the dish.
  const ingredients = plan ? plan.view.dish.ingredients : dish.ingredients;
  const steps = plan ? plan.view.dish.steps : dish.steps;
  const multiplier = plan ? plan.view.multiplier : 1;
  const runLine =
    plan?.run && makeAheadRunSteps(plan.view.dish.steps, plan.run) ? runCookLine(plan.run) : null;

  const onEdit = () => {
    console.log("[dish-detail] edit tapped", { dishId: dish.id });
    router.push({
      pathname: "/dish-builder",
      params: { dishId: dish.id },
    });
  };

  const macrosAllZero =
    dish.calories === 0 &&
    dish.protein === 0 &&
    dish.carbs === 0 &&
    dish.fat === 0;

  const metaParts = [
    dish.minutes > 0 ? `${dish.minutes} min` : null,
    `serves ${plan ? plan.view.servings : dish.servings}`,
  ].filter(Boolean) as string[];

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title={resolveDisplayTitle(dish)} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.hero}>
          {/* Treated image slot (16:10, warm-gradient placeholder default —
              dish photos ship in WS7-10). */}
          <TreatedImage
            source={dish.image ? { uri: dish.image } : null}
            aspectRatio={ImageTreatment.aspect.hero}
            radius={Radius["2xl"]}
            style={s.heroImage}
          />
          <DisplayTitle source={dish} variant="hero" style={s.heroTitle} />
          {dish.description && (
            <Text style={s.heroDescription}>{dish.description}</Text>
          )}
          <Text style={s.heroMeta}>{metaParts.join(" · ")}</Text>
          {/* Row 9 (1.1) Stripe S2 Part E -- the MACROS notice (§2.6). NAMED HERE
              TOO, though the ruling lists only the meal strip and the plan recalc:
              this is where a dish SAVED by a lapsed account lands, and
              "Macros not set" below would otherwise be the only explanation a user
              got for a figure the gate withheld. Reported as an addition. */}
          <BillingNotice
            text={macrosNoticeFor(subscription)}
            testID="dish-macros-notice"
          />
          <Text style={s.heroMacros}>
            {macrosAllZero
              ? "Macros not set"
              : `${formatMacro(dish.calories, "0")} cal · ${formatMacro(dish.protein, "0")}g P · ${formatMacro(dish.carbs, "0")}g C · ${formatMacro(dish.fat, "0")}g F`}
          </Text>
        </View>

        <View style={s.primaryActionStack}>
          <Button label="Cook Now" variant="primary" onPress={onCookNow} />
          {runLine ? <Text style={s.heroMeta}>{runLine}</Text> : null}
        </View>

        {/* D-WS9-006 / BUG-008 case 3 — the library-context "Compost" button is
            REMOVED, not restyled (D-WS9-099). It needs net-new backend that does
            not exist: there is no DELETE /me/dishes/:id and no compostedAt on
            Dish. Until this lane it opened a single informational alert reading
            "Coming soon — you'll be able to delete this dish", which is the
            definition of a work-in-progress feel on a screen a tester opens.
            BUG-008 case 3 STAYS OPEN; the affordance comes back with the route.
            Removal is one-line-reversible; a dead button seen by a tester is
            not. Edit keeps the row to itself.
            PREP-2 — not in plan context: Edit opens the dish builder on the
            catalog dish, which is not the plan's copy this screen is showing. */}
        {!plan && (
          <View style={s.actionRow}>
            <View style={{ flex: 1 }}>
              <Button label="Edit" variant="ghost" onPress={onEdit} />
            </View>
          </View>
        )}

        <View style={s.section}>
          <SectionLabel label="Ingredients" />
          {ingredients.map((ing, i) => (
            <Text key={i} style={s.ingredientLine}>
              {/* ①-follow-up — render 1.75 back as "1¾" via the existing
                  formatQuantity glyph formatter (same as Meal Detail), so a
                  fraction the user typed reads as a fraction on reopen.
                  Row 9 (1.1) · Stripe S2 Part E (BUG-317) — THE THIRD SCREEN.
                  This line used to compose itself: `formatQuantity(...) {unit}
                  {name}`, inline, the way all three screens did before BUG-315
                  moved two of them onto the shared formatter and left this one
                  behind. So "both screens change at once, by construction" was
                  true of two screens out of three, and a count-unit suppression
                  landing on the meal and guest screens would have left "1 each"
                  here. Now there is one formatter and three callers. */}
              {plan ? formatIngredientLine(ing, { multiplier }) : formatIngredientLine(ing)}
            </Text>
          ))}
        </View>

        {steps.length > 0 && (
          <View style={s.section}>
            <SectionLabel label="Steps" />
            {steps.map((step, i) => (
              <View key={i} style={s.stepRow}>
                <View
                  style={[
                    s.stepCircle,
                    step.isTimingSensitive
                      ? s.stepCircleTiming
                      : s.stepCircleNormal,
                  ]}
                >
                  <Text
                    style={
                      step.isTimingSensitive
                        ? s.stepCircleTextTiming
                        : s.stepCircleTextNormal
                    }
                  >
                    {i + 1}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  {/* PREP-2 — in plan context a ref-bearing step scales its amounts
                      by the same multiplier as the list (meal detail's rule). */}
                  {plan && step.amountRefs && step.amountRefs.length > 0 ? (
                    <Text style={s.stepText}>
                      {buildAmountRefSegments(step.text, step.amountRefs, multiplier).map((seg, k) => (
                        <Text key={k}>{seg.text}</Text>
                      ))}
                    </Text>
                  ) : (
                    <Text style={s.stepText}>{step.text}</Text>
                  )}
                  {step.estimatedMinutes !== undefined && (
                    <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: 200,
  },
  gateWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[5],
    gap: Spacing[3],
  },
  gateText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  gateBtnWrap: {
    minWidth: 160,
  },
  hero: {
    gap: Spacing[2],
  },
  // TreatedImage owns aspect / radius / placeholder / overlay; pin width only.
  heroImage: {
    width: "100%",
  },
  // BUG-035 — bold weight now rides the Fraunces_700Bold face (no synthetic bold).
  heroTitle: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    marginTop: Spacing[2],
  },
  heroDescription: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    lineHeight: 18,
  },
  heroMeta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  heroMacros: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  primaryActionStack: {
    gap: Spacing[2],
    marginTop: Spacing[4],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  section: {
    marginTop: Spacing[4],
  },
  ingredientLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepRow: {
    flexDirection: "row",
    gap: Spacing[3],
    marginBottom: Spacing[3],
    alignItems: "flex-start",
  },
  stepCircle: {
    width: 32,
    height: 32,
    // D-WS9-022 — full radius for a 32px circle (was the ambiguous old-xl 16).
    borderRadius: Radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleNormal: {
    backgroundColor: Colors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: Colors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepCircleTextTiming: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
