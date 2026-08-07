import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { DisplayTitle, resolveDisplayTitle } from "@/components/DisplayTitle";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { SectionLabel } from "@/components/SectionLabel";
import { TreatedImage } from "@/components/TreatedImage";
import {
  Colors,
  Copy,
  ImageTreatment,
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
  const { setServingsForPlanItem, updateMeal, addMealToPlan, removeMealFromPlan } =
    useApp();
  const { user: authUser } = useAuth();

  // Plan-instance context — true only when the screen was opened from a plan
  // item (both ids present); false in the Library (My Recipes). Gates the
  // Add-to-Plan button (Library only) and the Compost branch (plan vs library).
  const inPlanContext = !!(planId && planItemId);
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
    // BUG-008 case 2 — plan-context Compost removes this meal's plan item
    // (the Meal stays in My Meals), matching the Plan Review card path
    // exactly (handleCompostFromPlan → removeMealFromPlan → deletePlanItem).
    // We then route back to Plan Review, whose re-fetch (via the mutator's
    // query invalidation) shows the row gone — no local optimistic drop here
    // since this screen owns no plan list to filter.
    if (inPlanContext) {
      Alert.alert(
        "Compost meal",
        `Compost ${resolveDisplayTitle(meal)} from your plan? You can add it back later.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Compost",
            style: "destructive",
            onPress: () => {
              console.log("[meal-detail] compost-from-plan confirmed", {
                mealId: meal.id,
                planId,
                planItemId,
              });
              void removeMealFromPlan(planId!, planItemId!);
              router.replace({ pathname: "/plan/[id]", params: { id: planId! } });
            },
          },
        ],
      );
      return;
    }
    // BUG-008 case 3 — Library (My Recipes) meal soft-delete is net-new
    // backend, out of scope for this block. Unchanged WS5 stub behavior.
    Alert.alert(
      "Compost meal",
      `Compost ${resolveDisplayTitle(meal)}? It'll be removed from your meals and any plans it's in.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compost",
          style: "destructive",
          onPress: () => {
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
        mealTitle={resolveDisplayTitle(meal)}
        onClose={() => setAddToPlanVisible(false)}
        onPickExistingPlan={(plan) => {
          // BUG-004 — real wiring to the existing add-to-plan path
          // (addMealToPlan → POST /plans/:id/items). The sheet closes itself
          // on pick; we fire the mutation and confirm/err via Alert (the app
          // has no toast component — Alert is the standard affordance).
          console.log("[meal-detail] add-to-plan picked", {
            planId: plan.id,
            mealId: meal.id,
          });
          void addMealToPlan(plan.id, meal.id)
            .then(() => {
              Alert.alert("Added to plan", `${resolveDisplayTitle(meal)} was added to "${resolveDisplayTitle(plan)}".`);
            })
            .catch((err) => {
              console.warn("[meal-detail] add-to-plan failed", {
                planId: plan.id,
                mealId: meal.id,
                err,
              });
              Alert.alert(
                "Couldn't add to plan",
                "Something went wrong. Please try again.",
              );
            });
        }}
      />
      <Header
        showBack
        title={resolveDisplayTitle(meal)}
        rightContent={<HeartButton mealId={meal.id} />}
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero — treated image slot (16:10, warm-gradient placeholder is the
            default until meal photos ship in WS7-10), title in Fraunces,
            description, quick stats, and a display-only tag row. */}
        <View style={s.hero}>
          <TreatedImage
            source={meal.image ? { uri: meal.image } : null}
            aspectRatio={ImageTreatment.aspect.hero}
            radius={Radius["2xl"]}
            style={s.heroImage}
          />
          <DisplayTitle source={meal} variant="hero" style={s.heroTitle} />
          {meal.description && (
            <Text style={s.heroDescription}>{meal.description}</Text>
          )}
          <Text style={s.heroQuickStats}>{quickStatsParts.join(" · ")}</Text>
          {/* WS9 3f-1 — display-only tag chips (PRD §10.6.1), backed by the
              existing meal.tags. No tag INPUT is built here (that's D-WS9-101 →
              3f-2). The row is omitted entirely when the meal has no tags. */}
          {meal.tags.length > 0 && (
            <View style={s.tagRow}>
              {meal.tags.map((tag) => (
                <View key={tag} style={s.tagChip}>
                  <Text style={s.tagChipText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Primary actions per PRD §10.6 / A1 one-primary-per-zone: Cook Now is
            the sole primary (terracotta); Add to Plan steps down to secondary
            (white + border); Edit / Compost are tertiary ghosts below. */}
        <View style={s.primaryActionStack}>
          <Button label="Cook Now" variant="primary" onPress={onCookNow} />
          {/* BUG-004 — Add to Plan only in the Library (My Recipes) context;
              hidden when the meal is already in a plan (inPlanContext). */}
          {!inPlanContext && (
            <Button label="Add to Plan" variant="secondary" onPress={onAddToPlan} />
          )}
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
          <SectionLabel label="Ingredients" />
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
                <Text style={s.dishHeader}>For the {resolveDisplayTitle(dish)}:</Text>
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
          <SectionLabel label="Recipe steps" />
          {stepsAreGrouped
            ? meal.dishes
                .filter((dish) => dish.steps.length > 0)
                .map((dish) => (
                  <View key={dish.dishId} style={s.dishBlock}>
                    <Text style={s.dishHeader}>For the {resolveDisplayTitle(dish)}:</Text>
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
  hero: {
    gap: Spacing[2],
  },
  // TreatedImage owns the slot's aspect (16:10), radius, warm-gradient
  // placeholder, and terracotta overlay; this style only pins full width.
  heroImage: {
    width: "100%",
  },
  // BUG-035 — the bold weight now rides the Fraunces_700Bold FACE so the
  // numeric weight and the loaded face agree (no synthetic double-bold).
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
  heroQuickStats: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  // WS9 3f-1 — display-only tag chips. A near-neutral paper pill (not the
  // interactive Chip component, which is a Pressable built for selection).
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[1],
    marginTop: Spacing[1],
  },
  tagChip: {
    backgroundColor: Palette.chip.default.background,
    borderColor: Palette.chip.default.border,
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 3,
  },
  tagChipText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
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
