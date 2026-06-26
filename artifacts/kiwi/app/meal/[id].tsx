import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { AddMealToPlanSheet } from "@/components/AddMealToPlanSheet";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  Colors,
  Copy,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { useMeal } from "@/hooks/useMeal";
import { ApiError } from "@/lib/api/errors";
import type { MealDetail, MealStep } from "@/lib/api/meals";
import { buildAmountRefSegments } from "@/lib/cooking/amountSegments";
import { buildCookSessionParams } from "@/lib/cooking/cookSession";
import { formatMacro } from "@/lib/format/macros";
import { formatQuantity } from "@/lib/format/quantity";
import {
  clampServings,
  shouldShowCanonicalSaveServings,
  shouldShowSaveServings,
} from "@/lib/meals/servingsSaveGate";

const SERVINGS_MIN = 1;
const SERVINGS_MAX = 12;

// WS7-2 Block D (Commit 3): first UI consumer of the favorites API. Block B
// migrated favorites to React Query but nothing toggled them; this heart sits
// in the meal detail Header's rightContent slot. toggleFavorite is optimistic
// with rollback (AppContext), so the icon flips instantly; on API failure the
// mutator rolls the cache back and we surface a brief alert.
function HeartButton({ mealId }: { mealId: string }) {
  const { isFavorite, toggleFavorite } = useApp();
  const favorited = isFavorite(mealId);

  const onToggle = async () => {
    try {
      await toggleFavorite(mealId);
    } catch {
      Alert.alert(
        "Couldn't update favorites",
        "Something went wrong. Please try again.",
      );
    }
  };

  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        favorited ? "Remove from favorites" : "Add to favorites"
      }
      style={({ pressed }) => [s.heartBtn, pressed && { opacity: 0.6 }]}
    >
      <Ionicons
        name={favorited ? "heart" : "heart-outline"}
        size={24}
        color={favorited ? Colors.terracotta[600] : Colors.sage[700]}
      />
    </Pressable>
  );
}

// WS7-3 Block B: the screen now reads GET /meals/:id via useMeal. This
// component handles the read state machine — loading skeleton, a 404
// "meal not found" view, and a retry-able error banner for everything else —
// and hands the resolved MealDetail to <MealDetailContent>.
export default function MealDetailScreen() {
  const { id, planId, planItemId } = useLocalSearchParams<{
    id: string;
    planId?: string;
    planItemId?: string;
  }>();
  const mealId = id ?? "";
  const router = useRouter();

  // WS7-7-A B5 (D-WS7-090 read-side) — when opened from a plan item, thread
  // planItemId so the server applies that item's "just this time" override
  // (incl. a removed ingredient) to the detail we render here.
  const mealQuery = useMeal(mealId, planItemId);

  if (mealQuery.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Meal" showBack />
        <View style={s.gateWrap}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      </View>
    );
  }

  const meal = mealQuery.data;
  if (!meal) {
    // An empty id (missing route param) or a 404 → "meal not found";
    // anything else (network, 500, schema mismatch) → retry-able banner.
    const err = mealQuery.error;
    const isNotFound =
      mealId === "" || (err instanceof ApiError && err.status === 404);
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Meal" showBack />
        <View style={s.gateWrap}>
          <Text style={s.gateText}>
            {isNotFound
              ? "Meal not found."
              : "Couldn't load this meal. Please try again."}
          </Text>
          <View style={s.gateBtnWrap}>
            {isNotFound ? (
              <Button
                label="Go back"
                variant="ghost"
                onPress={() => router.back()}
              />
            ) : (
              <Button
                label="Try again"
                variant="primary"
                onPress={() => mealQuery.refetch()}
              />
            )}
          </View>
        </View>
      </View>
    );
  }

  // WS7-8b (D-WS7-169 keystone) — the plan-instance servings now resolve
  // server-side into meal.effectiveServings (for BOTH the today-card and Plans
  // entry paths, via useMeal's planItemId). The old `servingsOverride` route-
  // param seed is retired — both paths read one resolved server value, so they
  // can no longer disagree. (Partial down-payment on D-WS7-169: PlanReviewMealRow
  // still passes the now-ignored param; retiring that is the deferral's scope.)
  return (
    <MealDetailContent
      meal={meal}
      planId={planId}
      planItemId={planItemId}
    />
  );
}

function MealDetailContent({
  meal,
  planId,
  planItemId,
}: {
  meal: MealDetail;
  planId?: string;
  planItemId?: string;
}) {
  const router = useRouter();
  const { setServingsForPlanItem, updateMeal } = useApp();
  const { user: authUser } = useAuth();

  // §2.5 banner context — present only when the screen was opened from a plan
  // item. GET /meals/:id has no per-plan override concept, so this is derived
  // from the route params alone (the stub did the same via overrideContext).
  const hasOverride = !!(planId && planItemId);

  const [bannerDismissed, setBannerDismissed] = useState(false);
  // WS7-8b (D-WS7-169 keystone) — seed + display from the server-resolved
  // effectiveServings (servingsOverride ?? servingsDefault). In the library
  // context (no plan item) the server returns it === meal.servings, so this is
  // the canonical default. The stepper stays locally adjustable (optimistic +
  // rollback in applyServings); the authored meal.servings remains the scaling
  // denominator below.
  const [displayServings, setDisplayServings] = useState(meal.effectiveServings);
  const [addToPlanVisible, setAddToPlanVisible] = useState(false);
  const canPersistServings = !!(planId && planItemId);
  // BUG-006 follow-up — the latest in-flight servings write (already
  // .catch-guarded, so awaiting it never throws). Cook Now awaits this so it
  // never navigates ahead of a pending override write. Null when none pending.
  const pendingServingsWrite = useRef<Promise<void> | null>(null);

  // WS7-8b (D-WS7-169 / 3b) — re-sync the stepper when the server's resolved
  // servings changes under a mounted screen. Two drivers: (1) Apply-Always —
  // an edit refetches a new effectiveServings while this screen stays in the
  // stack; (2) WS7-8 BUG-003 B2.2 — an explicit servings Save invalidates
  // ["meals","detail"], refetching effectiveServings to the just-saved value
  // (clearing the dirty signal). Keyed on the resolved value only. Note the
  // stepper no longer writes per tap, so a stepped-but-unsaved value lives ONLY
  // in local displayServings — backing out (unmount) or any refetch resyncs the
  // display to the saved effectiveServings, silently discarding it (Hans-ruled).
  useEffect(() => {
    setDisplayServings(meal.effectiveServings);
  }, [meal.effectiveServings]);

  const showBanner = hasOverride && !bannerDismissed;
  // WS7-8b (D-WS7-169) / WS7-8 BUG-003 — DENOMINATOR is the immutable authored
  // anchor (meal.authoredServingsDefault), NOT effectiveServings and NOT the
  // (mutable) meal.servings. Ingredient quantities are authored against the
  // anchor, so scaling must divide by it; once a future canonical servings
  // change moves meal.servings, the anchor stays put and amounts rescale
  // correctly. The numerator is the live (possibly overridden) displayServings.
  // (The wire always sends authoredServingsDefault, falling back to
  // servingsDefault for legacy/seed rows, so this is never NaN.)
  const servingsMultiplier = displayServings / meal.authoredServingsDefault;
  const onlyOneDish = meal.dishes.length === 1;

  // Recipe steps. PRD §10.6 wants steps grouped by sub-dish, mirroring the
  // ingredients section. Steps are genuinely dish-owned only when the
  // top-level meal-owned `steps` array is empty — composeMealDetail copies
  // the meal-owned steps onto every dish as a fallback otherwise, so grouping
  // those would duplicate the same steps under each dish. Group only for a
  // multi-dish meal with empty meal-owned steps and at least one dish that
  // carries steps; every other case renders the existing flat list.
  const stepsAreGrouped =
    meal.dishes.length > 1 &&
    meal.steps.length === 0 &&
    meal.dishes.some((dish) => dish.steps.length > 0);
  const flatSteps =
    meal.steps.length > 0
      ? meal.steps
      : meal.dishes.flatMap((dish) => dish.steps);

  // Renders one numbered step row. `displayNumber` is the 1-based position
  // within its list (flat, or restarting per dish in the grouped layout).
  const renderStepRow = (step: MealStep, displayNumber: number, key: number) => (
    <View key={key} style={s.stepRow}>
      <View
        style={[
          s.stepCircle,
          step.isTimingSensitive ? s.stepCircleTiming : s.stepCircleNormal,
        ]}
      >
        <Text
          style={
            step.isTimingSensitive
              ? s.stepCircleTextTiming
              : s.stepCircleTextNormal
          }
        >
          {displayNumber}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        {/* WS7-8b BUG-003 Block 1 — ref-bearing steps render the structured
            amount × the SAME servingsMultiplier the ingredient list uses;
            null/[] amountRefs render plain text exactly as before. */}
        {step.amountRefs && step.amountRefs.length > 0 ? (
          <Text style={s.stepText}>
            {buildAmountRefSegments(step.text, step.amountRefs, servingsMultiplier).map(
              (seg, i) =>
                seg.isRef ? (
                  <Text key={i} style={s.stepQuantity}>
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
            )}
          </Text>
        ) : (
          <Text style={s.stepText}>{step.text}</Text>
        )}
        {/* Subtle, non-blocking clarify-any-time signal — only when a wired
            step has a real ingredient amount that resolved to no ingredient.
            Matched amounts in the same step still scale above. */}
        {step.unmatchedAmount === true && (
          <View style={s.stepUnmatchedHint}>
            <Feather name="alert-triangle" size={12} color={Colors.terracotta[500]} />
            <Text style={s.stepUnmatchedHintText}>
              Double-check the amounts in this step
            </Text>
          </View>
        )}
        {step.estimatedMinutes !== undefined && (
          <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
        )}
      </View>
    </View>
  );

  // WS7-8 BUG-003 B2.2 (PRD §10.6.1) — the stepper changes the DISPLAYED
  // servings ONLY; it no longer writes per tap. Persistence is an explicit
  // Save gate (onSaveServings below). In the library context there is no plan
  // item to write to either way, so the stepper stays purely display-only.
  const applyServings = (next: number) => {
    const clamped = clampServings(next, SERVINGS_MIN, SERVINGS_MAX);
    if (clamped === displayServings) return;
    setDisplayServings(clamped);
  };
  const decrementServings = () => applyServings(displayServings - 1);
  const incrementServings = () => applyServings(displayServings + 1);

  // The plan instance is dirty when the displayed servings diverges from the
  // server-resolved (saved) effectiveServings. Save is offered only in a plan
  // context — the library/canonical Save is Sub-block 3.
  const showSaveServings = shouldShowSaveServings(
    canPersistServings,
    displayServings,
    meal.effectiveServings,
  );
  const [savingServings, setSavingServings] = useState(false);

  // WS7-8 BUG-003 B2.2 — explicit Save. Persists the displayed value as the
  // plan item's servingsOverride (bumps the plan revision → grocery list
  // reconciles). Keeps the optimistic-set + rollback-on-failure posture; the
  // in-flight promise is tracked so onCookNow can await an explicit Save (NOT a
  // per-tap write) before navigating. On success the row is no longer dirty, so
  // the Save button disappears.
  const onSaveServings = () => {
    if (!canPersistServings || savingServings) return;
    const prev = meal.effectiveServings;
    const next = displayServings;
    setSavingServings(true);
    pendingServingsWrite.current = setServingsForPlanItem(
      planId!,
      planItemId!,
      next,
    )
      .catch(() => {
        // Roll the display back to the last saved value so the dirty signal
        // (and the Save button) reflect reality after a failed write.
        setDisplayServings(prev);
        Alert.alert(
          "Couldn't update servings",
          "We couldn't save that change. Please try again.",
        );
      })
      .finally(() => {
        setSavingServings(false);
      });
  };

  // WS7-8 BUG-003 B2.3 — the CANONICAL Save gate + handler for the
  // library/canonical Meal Detail (no plan context). Owner-only, and dirty
  // against the authored base `meal.servings` (the value being promoted), NOT
  // effectiveServings. Mutually exclusive with the instance gate above: this
  // fires only when !canPersistServings, that one only when canPersistServings.
  const isOwner = !!meal.userId && meal.userId === authUser?.id;
  const showCanonicalSaveServings = shouldShowCanonicalSaveServings(
    canPersistServings,
    isOwner,
    displayServings,
    meal.servings,
  );
  const [savingCanonicalServings, setSavingCanonicalServings] = useState(false);

  // WS7-8 BUG-003 B2.3 — explicit CANONICAL Save. Scalar-PATCHes the meal's
  // servingsDefault to the displayed value (NO dishes[] → server's scalar path,
  // sub-graph + amountRefs untouched, immutable anchor frozen). Same optimistic
  // posture as onSaveServings: the display already holds the stepped value;
  // roll it back to the saved `meal.servings` on failure. On success updateMeal
  // invalidates ["meals","detail",id]; the refetch re-seeds displayServings from
  // the new effectiveServings, clearing the dirty signal. Back-out without
  // saving silently discards (the stepper-only value lives in local state).
  const onSaveCanonicalServings = () => {
    if (canPersistServings || !isOwner || savingCanonicalServings) return;
    const prev = meal.servings;
    const next = displayServings;
    setSavingCanonicalServings(true);
    updateMeal(meal.id, { servingsDefault: next })
      .catch(() => {
        setDisplayServings(prev);
        Alert.alert(
          "Couldn't update servings",
          "We couldn't save that change. Please try again.",
        );
      })
      .finally(() => {
        setSavingCanonicalServings(false);
      });
  };

  const onSaveGlobally = () => {
    console.log("[meal-detail] save-globally tapped", {
      mealId: meal.id,
      planId,
      planItemId,
    });
    Alert.alert(
      "Coming in WS7",
      "Saving changes globally requires the API client. This action will be wired in WS7.",
    );
  };

  const onKeepPlanOnly = () => {
    console.log("[meal-detail] keep-plan-only tapped", { mealId: meal.id });
    setBannerDismissed(true);
  };

  const onEdit = () => {
    console.log("[meal-detail] edit tapped", { mealId: meal.id });
    // Forward plan context (when present) so Meal Builder's Save flow can
    // surface the §2.5 prompt for edit-from-plan vs. global save.
    router.push({
      pathname: "/meal-builder",
      params: {
        mealId: meal.id,
        ...(planId && planItemId ? { planId, planItemId } : {}),
      },
    });
  };

  const onCookNow = async () => {
    console.log("[meal-detail] cook-now tapped", { mealId: meal.id });
    // BUG-006 — pass plan context (planId + planItemId) so Cook Mode resolves
    // this item's servingsOverride and scales amounts, matching the plan-card
    // path. Omitted in the Library (no plan context) → base amounts, correct.
    // First await any in-flight servings write so Cook Mode reads the current
    // value, not the prior override (tap-then-immediately-cook race). No
    // pending write → no await, no perceptible delay.
    if (pendingServingsWrite.current) {
      await pendingServingsWrite.current;
    }
    router.push({
      pathname: "/cook-session",
      params: buildCookSessionParams({ mealId: meal.id, planId, planItemId }),
    });
  };

  const onAddToPlan = () => {
    console.log("[meal-detail] add-to-plan tapped", { mealId: meal.id });
    setAddToPlanVisible(true);
  };

  const onCompost = () => {
    console.log("[meal-detail] compost tapped", { mealId: meal.id });
    Alert.alert(
      "Compost meal",
      `Compost ${meal.title}? It'll be removed from your meals and any plans it's in.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compost",
          style: "destructive",
          onPress: () => {
            // For WS5: confirmation flow only — real soft-delete +
            // active-plan cleanup requires the API client (WS7).
            // The double-alert pattern keeps the flow feeling real
            // for smoke testing. WS7 reviewer: replace the inner
            // "Coming in WS7" alert with deleteMealAndCleanup() →
            // router.back().
            console.log("[meal-detail] compost confirmed", {
              mealId: meal.id,
            });
            Alert.alert(
              "Coming in WS7",
              "Soft-deleting the meal record and removing from active plans requires the API client. The action will fully wire in WS7.",
              [{ text: "OK", onPress: () => router.back() }],
            );
          },
        },
      ],
    );
  };

  const difficultyLabel =
    meal.difficulty === "easy"
      ? "Easy"
      : meal.difficulty === "medium"
        ? "Medium"
        : "Hard";

  const quickStatsParts = [
    meal.cuisine,
    difficultyLabel,
    `${meal.minutes} min`,
    // WS7-7-A B5 (Issue C) — hero quick-stats track the live (possibly
    // overridden) servings, matching the stepper + ingredient scaling, not
    // the static server default `meal.servings`.
    `${displayServings} servings`,
  ].filter(Boolean) as string[];

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <AddMealToPlanSheet
        visible={addToPlanVisible}
        mealId={meal.id}
        mealTitle={meal.title}
        onClose={() => setAddToPlanVisible(false)}
        onPickExistingPlan={(plan) => {
          console.log("[meal-detail] add-to-plan picked", {
            planId: plan.id,
            mealId: meal.id,
          });
          Alert.alert(
            "Coming in WS7",
            `When the API client lands, ${meal.title} will be added to "${plan.name}".`,
          );
          setAddToPlanVisible(false);
        }}
      />
      <Header
        showBack
        title={meal.title}
        rightContent={<HeartButton mealId={meal.id} />}
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* §2.5 — Save Globally banner (only when accessed from a plan with active override) */}
        {showBanner && (
          <View style={s.banner}>
            <Text style={s.bannerText}>
              This recipe is customized for this plan. Save these changes to
              your saved meal so future plans use them too?
            </Text>
            <View style={s.bannerBtnRow}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Save to my meal forever"
                  variant="primary"
                  onPress={onSaveGlobally}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Keep plan-only"
                  variant="ghost"
                  onPress={onKeepPlanOnly}
                />
              </View>
            </View>
          </View>
        )}

        {/* Hero — image + title + description + quick stats */}
        <View style={s.hero}>
          {meal.image ? (
            <Image source={{ uri: meal.image }} style={s.heroImage} />
          ) : (
            <View style={[s.heroImage, s.heroFallback]} />
          )}
          <Text style={s.heroTitle}>{meal.title}</Text>
          {meal.description && (
            <Text style={s.heroDescription}>{meal.description}</Text>
          )}
          <Text style={s.heroQuickStats}>{quickStatsParts.join(" · ")}</Text>
        </View>

        {/* Primary actions per PRD §10.6: Cook Now (most prominent),
            then Add to Plan. Secondary library actions (Edit, Compost)
            sit below as a row. */}
        <View style={s.primaryActionStack}>
          <Button label="Cook Now" variant="primary" onPress={onCookNow} />
          <Button label="Add to Plan" variant="primary" onPress={onAddToPlan} />
        </View>
        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button label="Edit" variant="ghost" onPress={onEdit} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={Copy.delete} variant="ghost" onPress={onCompost} />
          </View>
        </View>

        {/* Per-serving macros */}
        <View style={s.section}>
          <Card>
            <Text style={s.cardTitle}>Per serving</Text>
            <View style={s.macroRow}>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.calories)}</Text>
                <Text style={s.macroLabel}>cal</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.protein)}</Text>
                <Text style={s.macroLabel}>g protein</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.carbs)}</Text>
                <Text style={s.macroLabel}>g carbs</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.fat)}</Text>
                <Text style={s.macroLabel}>g fat</Text>
              </View>
            </View>
          </Card>
        </View>

        {/* Ingredients */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Ingredients</Text>
          <View style={s.servingsAdjuster}>
            <Text style={s.servingsLabel}>Adjust for</Text>
            <View style={s.stepperRow}>
              <Pressable
                onPress={decrementServings}
                disabled={displayServings <= SERVINGS_MIN}
                hitSlop={6}
                style={({ pressed }) => [
                  s.stepperBtn,
                  displayServings <= SERVINGS_MIN && { opacity: 0.4 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Feather name="minus" size={16} color={Colors.sage[700]} />
              </Pressable>
              <Text style={s.stepperValue}>{displayServings}</Text>
              <Pressable
                onPress={incrementServings}
                disabled={displayServings >= SERVINGS_MAX}
                hitSlop={6}
                style={({ pressed }) => [
                  s.stepperBtn,
                  displayServings >= SERVINGS_MAX && { opacity: 0.4 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Feather name="plus" size={16} color={Colors.sage[700]} />
              </Pressable>
            </View>
            <Text style={s.servingsLabel}>servings</Text>
          </View>

          {/* WS7-8 BUG-003 B2.2 (PRD §10.6.1) — explicit Save gate. Appears
              ONLY in a plan context with an unsaved stepper change; tapping it
              persists the displayed servings as the plan item's override.
              Navigating away without saving silently discards the change. */}
          {showSaveServings && (
            <View style={s.saveServingsRow}>
              <Button
                label="Save changes"
                variant="primary"
                onPress={onSaveServings}
                loading={savingServings}
              />
            </View>
          )}

          {/* WS7-8 BUG-003 B2.3 — CANONICAL Save gate. Appears ONLY in the
              library/canonical context (no plan item), owner-only, with the
              stepper diverged from the authored base. Tapping it scalar-promotes
              the meal's servingsDefault. Mutually exclusive with the instance
              Save above. Same silent-discard-on-back-out posture. */}
          {showCanonicalSaveServings && (
            <View style={s.saveServingsRow}>
              <Button
                label="Save changes"
                variant="primary"
                onPress={onSaveCanonicalServings}
                loading={savingCanonicalServings}
              />
            </View>
          )}

          {meal.dishes.map((dish) => (
            <View key={dish.dishId} style={s.dishBlock}>
              {!onlyOneDish && (
                <Text style={s.dishHeader}>For the {dish.title}:</Text>
              )}
              {dish.ingredients.map((ing, i) => (
                <Text key={i} style={s.ingredientLine}>
                  {formatQuantity(ing.quantity * servingsMultiplier, ing.unit)}{" "}
                  {ing.unit} {ing.name}
                </Text>
              ))}
            </View>
          ))}
        </View>

        {/* Recipe steps — grouped by sub-dish for multi-dish meals
            (PRD §10.6, mirroring the ingredients section); one flat
            numbered list otherwise. */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Recipe steps</Text>
          {stepsAreGrouped
            ? meal.dishes
                .filter((dish) => dish.steps.length > 0)
                .map((dish) => (
                  <View key={dish.dishId} style={s.dishBlock}>
                    <Text style={s.dishHeader}>For the {dish.title}:</Text>
                    {dish.steps.map((step, i) =>
                      renderStepRow(step, i + 1, i),
                    )}
                  </View>
                ))
            : flatSteps.map((step, i) => renderStepRow(step, i + 1, i))}
        </View>
      </KeyboardAwareScrollViewCompat>
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
  banner: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
    gap: Spacing[2],
    marginBottom: Spacing[4],
  },
  bannerText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  bannerBtnRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  hero: {
    gap: Spacing[2],
  },
  heroImage: {
    width: "100%",
    height: 200,
    borderRadius: Radius.lg,
    backgroundColor: Colors.neutral[200],
  },
  heroFallback: {
    backgroundColor: Colors.sage[100],
  },
  heroTitle: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[2],
  },
  heroDescription: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    lineHeight: 18,
  },
  heroQuickStats: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
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
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  macroRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing[2],
  },
  macroStat: { alignItems: "center", flex: 1 },
  macroValue: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  macroLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  sectionHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[3],
  },
  servingsAdjuster: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    marginBottom: Spacing[3],
  },
  // WS7-8 BUG-003 B2.2 — explicit servings-Save affordance; sits between the
  // stepper and the ingredient list, full-width to match the primary actions.
  saveServingsRow: {
    marginBottom: Spacing[3],
  },
  servingsLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  stepperBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    minWidth: 20,
    textAlign: "center",
  },
  dishBlock: {
    marginTop: Spacing[3],
    gap: 4,
  },
  dishHeader: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
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
    borderRadius: 16,
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
  // WS7-8b BUG-003 Block 1 — structured ref amount, terracotta (mirrors the
  // Cook Mode quantity treatment, Palette.cookMode.quantity).
  stepQuantity: {
    color: Palette.cookMode.quantity.color,
    fontFamily: Typography.face.sans[700],
  },
  // Subtle clarify-any-time signal (terracotta tint, non-blocking, no modal).
  stepUnmatchedHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
  },
  stepUnmatchedHintText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[400],
  },
  stepMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  heartBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
