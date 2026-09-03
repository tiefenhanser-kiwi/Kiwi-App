// WS7-8b Block 2 — the Prep & Cook Hub: the landing screen for an active
// plan's cooking actions (PRD §13.3, design spec §2.1). Replaces the WS5-5R
// "coming soon" stub.
//
// PLAN RESOLUTION (Option A, agreed in Phase 0): the Hub accepts an optional
// `id` param. When absent it falls back to the server's `activeThisWeek` plan
// (usePlans) — it deliberately does NOT read useApp().currentPlan, the legacy
// AsyncStorage cache. When neither yields a plan, the Hub renders a real
// "no plan this week" empty state that nudges toward making one.
//
// Single-meal Cook session (Block 3) and Week Prep (Block 4) don't exist yet.
// Meal taps + the "Cook a meal" lane route to the temporary /cook-session stub;
// "Prep the Week" routes to the same temporary stub flagged as Week-Prep. We do
// NOT fake either destination here.
//
// WS7-8b Block 2-fix — the null-plan empty state also lists the user's existing
// (instance) plans; "Cook this week" promotes one via the existing
// setPlanActiveThisWeek mutator. Its ["plans"] invalidation refetches usePlans,
// activeThisWeek flips to the promoted plan, and this screen re-resolves to the
// populated Hub — no confirmation, no new promote path, no useApp().currentPlan.

import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { PrepCookHubView } from "@/components/PrepCookHubView";
import { useApp } from "@/contexts/AppContext";
import { usePlan } from "@/hooks/usePlan";
import { usePlans } from "@/hooks/usePlans";
import {
  buildPrepCookHubModel,
  buildPromotablePlans,
  resolveHubPlanId,
  type HubModel,
} from "@/lib/cooking/hubModel";
import { DAY_OF_WEEK_VALUES } from "@/lib/plans/dayOfWeek";
import { Colors, Spacing, Typography } from "@/constants/tokens";

export default function PrepCook() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const { setPlanActiveThisWeek } = useApp();

  // The plan whose promote is in flight (empty-state). Cleared on failure; on
  // success the Hub re-resolves and unmounts the empty state, so it's moot.
  const [promotingPlanId, setPromotingPlanId] = useState<string | null>(null);

  // WS9 Prep Selected Meals — which this-week meals are ticked for a subset
  // prep run. Screen-local and deliberately NOT persisted: a subset run is a
  // live AI call with no server cache behind it, so a selection that survived a
  // remount could quietly launch a second paid generation.
  const [selectedMealIds, setSelectedMealIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggleMealSelected = (mealId: string) =>
    setSelectedMealIds((prev) => {
      const next = new Set(prev);
      if (next.has(mealId)) next.delete(mealId);
      else next.add(mealId);
      return next;
    });

  // Option A — explicit id wins; otherwise resolve "this week's" plan from the
  // server. usePlans(["my_plans"]) is the same canonical source Home uses.
  const explicitId = typeof params.id === "string" ? params.id : "";
  const plansQuery = usePlans(["my_plans"]);
  const resolution = resolveHubPlanId(
    explicitId,
    plansQuery.data?.activeThisWeek?.id,
    plansQuery.isLoading,
  );
  const resolvedId = resolution.planId ?? "";

  const planQuery = usePlan(resolvedId);

  const todayDayName = DAY_OF_WEEK_VALUES[new Date().getDay()];

  // Promote an existing plan to "this week". The Hub re-resolves via the
  // mutator's ["plans"] invalidation; we only track in-flight UI here.
  const onCookThisWeek = (planId: string) => {
    if (promotingPlanId) return; // guard against a second concurrent promote
    setPromotingPlanId(planId);
    void (async () => {
      try {
        await setPlanActiveThisWeek(planId);
        // Success: leave promotingPlanId set — the ["plans"] refetch flips
        // activeThisWeek and this screen re-resolves to the populated Hub.
      } catch (err) {
        console.warn("[prep-cook] cook-this-week failed", err);
        setPromotingPlanId(null); // re-enable the cards for a retry
      }
    })();
  };

  // ── Navigation handoffs ───────────────────────────────────────────────────
  // WS7-8b B3 — Cook Mode launch WITH plan context: pass planId (the resolved
  // Hub plan) + planItemId so the cook screen reads isPrepped via usePlan and
  // drives the prep gate without asking.
  const goCookSession = (mealId: string, planItemId: string) =>
    router.push({
      pathname: "/cook-session",
      params: { mealId, planId: resolvedId, planItemId },
    });

  // WS7-8b D-WS7-158 — the "Cook a meal" lane is now a text prompt over the
  // this-week meal list; the action is tapping a meal row (goCookSession), so
  // there is no separate lane handler. The old inert no-param handoff is gone.

  // "Prep the Week" → Week Prep (Block 4). Pass the resolved Hub planId (Option A,
  // same single resolution path goCookSession uses) so the cook-session route can
  // mount <PrepWeekScreen planId={…}/> and call getPrepWeek + the completion verbs.
  const goPrepWeek = () =>
    router.push({
      pathname: "/cook-session",
      params: { mode: "prep-week", planId: resolvedId },
    });

  // WS9 — the subset launch. Same screen, same route, one extra param. Ids are
  // ordered by the plan's own meal order (not tick order) so the same selection
  // always produces the same URL and therefore the same React Query key — one
  // AI call, not one per ordering. Guarded: an empty selection never navigates
  // (the CTA is already disabled; this is the second lock on a paid call).
  const goPrepSelected = () => {
    const ordered = (planQuery.data?.items ?? [])
      .map((it) => it.mealId)
      .filter((id) => selectedMealIds.has(id));
    if (ordered.length === 0) return;
    router.push({
      pathname: "/cook-session",
      params: {
        mode: "prep-week",
        planId: resolvedId,
        mealIds: ordered.join(","),
      },
    });
  };

  const goMakePlan = () => router.push("/wizard");

  // ── State resolution ──────────────────────────────────────────────────────
  let model: HubModel | null = null;
  if (resolution.planId !== null) {
    if (planQuery.data) {
      // Tags aren't on the detail payload — pull them from the discovery list
      // we already load (slated for removal next block). Empty when the plan
      // isn't on this page.
      const tags =
        plansQuery.data?.plans.find((p) => p.id === resolvedId)?.tags ?? [];
      model = buildPrepCookHubModel(planQuery.data, todayDayName, tags);
    }
  } else if (!resolution.resolving) {
    // Resolved with no plan: a real empty state. Offer the user's existing
    // instance plans as one-tap "cook this week" promotes. First page only —
    // pagination is the logged gap (D-WS7-156).
    model = {
      kind: "empty",
      plans: buildPromotablePlans(plansQuery.data?.plans ?? []),
    };
  }

  if (model) {
    return (
      <PrepCookHubView
        model={model}
        onPrepWeek={goPrepWeek}
        onPrepSelected={goPrepSelected}
        onToggleMealSelected={toggleMealSelected}
        selectedMealIds={selectedMealIds}
        onSelectMeal={goCookSession}
        onMakePlan={goMakePlan}
        onCookThisWeek={onCookThisWeek}
        promotingPlanId={promotingPlanId}
      />
    );
  }

  // Still resolving, or the plan read errored.
  const isError = resolvedId.length > 0 && planQuery.isError;
  return (
    <View style={local.bg}>
      <Header showBack title="Prep & Cook" />
      <Screen>
        <View style={local.center}>
          {isError ? (
            <Text style={local.errorText}>
              We couldn&apos;t load this plan. Pull back and try again.
            </Text>
          ) : (
            <ActivityIndicator color={Colors.sage[700]} />
          )}
        </View>
      </Screen>
    </View>
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
