// WS7-8b Block 3 — single-meal Cook Mode. Replaces the temporary stub.
//
// Launches by EITHER mealId (multi-dish-capable meal) OR dishId (forced
// single-dish — cook that dish only), plus optional planId + planItemId for
// prep context. `mode=prep-week` is left as a stub — that route belongs to
// Block 4 (Week Prep) and is intentionally untouched here.
//
// CRITICAL INVARIANT: prep state is READ only from plan/instance context
// (PlanDetailItem.isPrepped via usePlan). The Meal/Dish recipe (useMeal/useDish)
// is render-only. Nothing here writes a prep mark — per-meal prep write-back is
// D-WS7-157 (Block 4), where the prep-week step-keys are in scope. The gate
// reads + filters in memory only.

import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { CookSessionView } from "@/components/CookSessionView";
import { resolveDisplayTitle } from "@/components/DisplayTitle";
import { Header } from "@/components/Header";
import { PrepWeekScreen } from "@/components/PrepWeekScreen";
import { Screen } from "@/components/Screen";
import { useCookingSequence } from "@/hooks/useCookingSequence";
import { useDish } from "@/hooks/useDish";
import { useMeal } from "@/hooks/useMeal";
import { usePlan } from "@/hooks/usePlan";
import {
  applyPrepFilter,
  flattenDishSteps,
  flattenMealSteps,
  misePlaceItems,
  remainingMinutes,
  resolveAmountMultiplier,
  resolveCookRender,
  resolvePrepGate,
  sequenceMealSteps,
  type CookStep,
} from "@/lib/cooking/cookSession";
import { Colors, Spacing, Typography } from "@/constants/tokens";

const TOAST_MS = 2500;

export default function CookSession() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    mealId?: string;
    dishId?: string;
    planId?: string;
    planItemId?: string;
    mode?: string;
    mealIds?: string;
  }>();
  const mealId = typeof params.mealId === "string" ? params.mealId : "";
  const dishId = typeof params.dishId === "string" ? params.dishId : "";
  const planId = typeof params.planId === "string" ? params.planId : "";
  const planItemId = typeof params.planItemId === "string" ? params.planItemId : "";
  const mode = typeof params.mode === "string" ? params.mode : "";
  // WS9 Prep Selected Meals — the chosen plan meals ride the URL as a
  // comma-joined list (expo-router params are strings). Empty/absent ⇒ full
  // week, which keeps every existing `mode=prep-week` deep link unchanged.
  const mealIds = useMemo(() => {
    const raw = typeof params.mealIds === "string" ? params.mealIds : "";
    const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return ids.length > 0 ? ids : undefined;
  }, [params.mealIds]);

  // All hooks run every render (rules of hooks); empty ids leave queries disabled.
  const mealQuery = useMeal(mealId, planItemId || undefined);
  const dishQuery = useDish(dishId);
  const planQuery = usePlan(planId);

  // ── Cooking Sequencer gate (PRD §13.5.4 / §7.13) ───────────────────────────
  // Call the Sequencer ONLY for a genuine multi-dish meal that renders from
  // dish steps (meal-owned steps[] are not dish-scoped, so the sequence can't
  // map back). dishId launches and single-dish meals degrade to naive ordering
  // and never hit the endpoint. The hook's `enabled` keeps it inert otherwise.
  const isMultiDish =
    mealId.length > 0 &&
    !!mealQuery.data &&
    mealQuery.data.steps.length === 0 &&
    mealQuery.data.dishes.length > 1;
  const seqQuery = useCookingSequence(mealId, isMultiDish);

  // Graceful degradation (§13.5.5): a Sequencer failure is non-fatal — the meal
  // still cooks in naive order. Log it, never error the screen.
  useEffect(() => {
    if (seqQuery.isError) {
      console.warn(
        "[cook-session] Cooking Sequencer failed — falling back to naive ordering",
        seqQuery.error,
      );
    }
  }, [seqQuery.isError, seqQuery.error]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [prepAnswer, setPrepAnswer] = useState<boolean | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  // Toast auto-hide (PRD §7.12 — 2-3s).
  useEffect(() => {
    if (!toastVisible) return;
    const t = setTimeout(() => setToastVisible(false), TOAST_MS);
    return () => clearTimeout(t);
  }, [toastVisible]);

  // ── Build the ordered step list (recipe is render-only) ────────────────────
  // Multi-dish + a successful Sequencer result → the unified intermixed flow
  // with parallel cues. Otherwise (single-dish, dishId, meal-owned steps, or a
  // failed/in-flight Sequencer) → naive ordering. The join never drops a step.
  const allSteps: CookStep[] = useMemo(() => {
    if (mealId && mealQuery.data) {
      if (isMultiDish && seqQuery.data) {
        return sequenceMealSteps(mealQuery.data, seqQuery.data.sequence);
      }
      return flattenMealSteps(mealQuery.data);
    }
    if (dishId && dishQuery.data) return flattenDishSteps(dishQuery.data);
    return [];
  }, [mealId, dishId, mealQuery.data, dishQuery.data, isMultiDish, seqQuery.data]);

  // ── WS7-8b BUG-006 — amount-ref scale ───────────────────────────────────────
  // Cook Mode renders amountRefs through this so the cook screen scales to the
  // same quantities as Meal Detail. Meal path: effectiveServings (plan-resolved)
  // ÷ the immutable authored anchor (authoredServingsDefault), matching Meal
  // Detail's denominator (WS7-8 BUG-003). DishId path: 1 — a standalone dish has
  // no plan override (the dish-of-an-overridden-plan-meal case is a chosen
  // limitation, D-WS7-175).
  const amountMultiplier = useMemo(() => {
    if (mealId && mealQuery.data) {
      return resolveAmountMultiplier(
        mealQuery.data.effectiveServings,
        mealQuery.data.authoredServingsDefault,
      );
    }
    return 1;
  }, [mealId, mealQuery.data]);

  // ── Prep gate (read-only) ──────────────────────────────────────────────────
  const wantPlan = planId.length > 0 && planItemId.length > 0;
  const planItem = planQuery.data?.items.find((i) => i.id === planItemId);
  const hasPlanContext = wantPlan && planItem != null;
  const gate = resolvePrepGate(hasPlanContext, planItem?.isPrepped ?? false);

  const needsGatePrompt = gate === "unknown" && prepAnswer === null;
  const skipPrep =
    gate === "prepped" || (gate === "unknown" && prepAnswer === true);
  const prepped = skipPrep;
  const showSkipBar = gate === "prepped";

  const activeSteps = useMemo(
    () => applyPrepFilter(allSteps, skipPrep),
    [allSteps, skipPrep],
  );
  const recapItems = useMemo(() => misePlaceItems(allSteps), [allSteps]);

  const title = resolveDisplayTitle(mealQuery.data ?? dishQuery.data, "Cook");

  // ── Fail-safe: a launch with no meal/dish should never happen (the no-param
  // Hub handoff was removed). If one slips through, route back rather than
  // designing an empty state for it. ──────────────────────────────────────────
  useEffect(() => {
    if (mode !== "prep-week" && !mealId && !dishId) {
      router.back();
    }
  }, [mode, mealId, dishId, router]);

  // ── Week Prep (Screen 3) — the real screen replaces the Block-2 stub. planId
  // arrives via goPrepWeek's push params (Option A, the Hub's single resolution
  // path); an empty planId renders a graceful no-plan state inside the screen. ─
  if (mode === "prep-week") {
    // onExit (Header back + celebratory finish) → router.back() lands on the Hub.
    // onSaveExit (BUG-020 "Save & Exit") → a quiet replace to this plan's Meal
    // Plan Detail screen; guard an empty planId by falling back to back().
    return (
      <PrepWeekScreen
        planId={planId}
        mealIds={mealIds}
        onExit={() => router.back()}
        onSaveExit={() =>
          planId.length > 0
            ? router.replace({ pathname: "/plan/[id]", params: { id: planId } })
            : router.back()
        }
      />
    );
  }

  if (!mealId && !dishId) {
    return <View style={local.bg} />;
  }

  // Loading: recipe in flight, or plan context still resolving, or the
  // multi-dish Sequencer call in flight (brief — only the multi-dish path).
  // `isLoading` is false when the query is disabled or has errored, so this
  // never blocks a single-dish launch or a degraded (failed) sequence.
  const recipeLoading =
    (mealId.length > 0 && mealQuery.isLoading) ||
    (dishId.length > 0 && dishQuery.isLoading);
  const planResolving = wantPlan && planQuery.isLoading;
  const sequenceLoading = isMultiDish && seqQuery.isLoading;
  const recipeError =
    (mealId.length > 0 && mealQuery.isError) ||
    (dishId.length > 0 && dishQuery.isError);

  // Polish #1 (D-WS7-165): show the prep gate immediately and load the step data
  // behind it. The render order is the pure `resolveCookRender` contract — we
  // still block on the cheap `planResolving` (the isPrepped source) before the
  // gate so a State-1/2 launch never flashes the State-3 question, but the slow
  // recipe/sequence fetch no longer blocks the State-3 gate prompt.
  const renderState = resolveCookRender({
    recipeError,
    planResolving,
    recipeLoading,
    sequenceLoading,
    needsGatePrompt,
  });

  if (renderState === "error") {
    return (
      <View style={local.bg}>
        <Header showBack title="Cook" />
        <Screen>
          <View style={local.center}>
            <Text style={local.errorText}>
              We couldn&apos;t load this recipe. Pull back and try again.
            </Text>
          </View>
        </Screen>
      </View>
    );
  }
  if (renderState === "plan-loading" || renderState === "recipe-loading") {
    return (
      <View style={local.bg}>
        <Header showBack title="Cook" />
        <Screen>
          <View style={local.center}>
            <ActivityIndicator color={Colors.sage[700]} />
          </View>
        </Screen>
      </View>
    );
  }
  // "gate" and "session" both fall through to CookSessionView; the gate render
  // is driven by `gatePromptVisible={needsGatePrompt}`, so an empty `activeSteps`
  // while the recipe loads behind the gate is fine.

  // Clamp the anchor index to the (possibly filtered) active list.
  const safeIndex =
    activeSteps.length === 0
      ? 0
      : Math.min(Math.max(0, currentIndex), activeSteps.length - 1);

  const advance = () =>
    setCurrentIndex((i) => Math.min(i + 1, Math.max(0, activeSteps.length - 1)));
  const prev = () => setCurrentIndex((i) => Math.max(0, i - 1));
  const selectStep = (i: number) => {
    // Tap the current step → advance; tap any other → jump to it (free nav).
    if (i === safeIndex) advance();
    else setCurrentIndex(i);
  };
  const onPrepAnswer = (didPrep: boolean) => {
    setPrepAnswer(didPrep);
    setCurrentIndex(0);
    if (didPrep) setToastVisible(true); // verbatim toast fires on the "Yes" tap
  };

  return (
    <CookSessionView
      title={title}
      steps={activeSteps}
      amountMultiplier={amountMultiplier}
      currentIndex={safeIndex}
      prepped={prepped}
      showSkipBar={showSkipBar}
      recapItems={recapItems}
      remainingMins={remainingMinutes(activeSteps, safeIndex)}
      onAdvance={advance}
      onPrevStep={prev}
      onSelectStep={selectStep}
      onSkipToCooking={() => setCurrentIndex(0)}
      gatePromptVisible={needsGatePrompt}
      onPrepAnswer={onPrepAnswer}
      toastVisible={toastVisible}
      onExit={() => router.back()}
    />
  );
}

const local = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
  center: { paddingTop: Spacing[8], alignItems: "center" },
  errorText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    fontFamily: Typography.face.sans[400],
    paddingHorizontal: Spacing[5],
  },
});
