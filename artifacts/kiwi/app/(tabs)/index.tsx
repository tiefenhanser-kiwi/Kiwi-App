// WS9 Block 3a — the two-lane Home (flagship). Layout top→bottom (spec §5.1):
// header (owns mark · greeting · badge + avatar chip) → teaching arc (first-run
// only) → make-lane eyebrow → Tell Kiwi card → tonight strip (below the make
// lane) → Tried & True eyebrow → Tried & True rail → utility row.
//
// This screen supplies ROUTING to the dumb Layer-2b primitives (TellKiwiCard,
// ActivePlanStrip, TriedTrueCard, SectionLabel, TreatedImage) and owns the
// ordering the cards don't. Removed vs the pre-3a home: HeroCard, the two
// WizardCtaCards, CookNowCtaCard, PlanDiscoveryCard, the HomeActionButton row.

import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { ActivePlanStrip } from "@/components/ActivePlanStrip";
import { GroceryGeneratingOverlay } from "@/components/GroceryGeneratingOverlay";
import { HomeHeader } from "@/components/HomeHeader";
import { PlanPreviewModal } from "@/components/PlanPreviewModal";
import { Screen } from "@/components/Screen";
import { SectionLabel } from "@/components/SectionLabel";
import { TeachingArc } from "@/components/TeachingArc";
import { TellKiwiCard } from "@/components/TellKiwiCard";
import { TriedTrueCard } from "@/components/TriedTrueCard";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useGroceryGeneration } from "@/hooks/useGroceryGeneration";
import { useHomePayload } from "@/hooks/useHomePayload";
import { usePlans } from "@/hooks/usePlans";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useTemplatePreview } from "@/hooks/useTemplatePreview";
import { resolveGroceryRoute } from "@/lib/groceryPicker";
import { deriveHeroModel } from "@/lib/home/heroState";
import { buildTriedTrueRail, TRIED_TRUE_BADGES } from "@/lib/home/triedTrue";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();
  const { useTemplateAsPlan } = useApp();
  const { generate: generateGroceries, isGenerating } = useGroceryGeneration();

  // Paywall: an expired/lapsed subscription routes the MAKE-lane actions to
  // upgrade (preserved from the pre-3a home; grocery/prep/cook stay ungated as
  // before). Trialing/active pass through.
  const isLocked = useMemo(() => {
    const status = user?.subscription?.status;
    if (!status) return false;
    return status !== "trialing" && status !== "active";
  }, [user?.subscription?.status]);

  // GET /home drives the hero/tonight state + the first-run arc gate.
  const homeQuery = useHomePayload();
  useRefetchOnFocus(homeQuery);
  const heroModel = deriveHeroModel(homeQuery.data);

  // D-WS9-026 — arc collapses PERMANENTLY once firstPlanCreatedAt is non-null.
  // While the payload loads (undefined), suppress the arc rather than flash it
  // (a returning user must never see the first-run treatment). null AND loaded
  // ⇒ genuine first run.
  const isFirstRun = homeQuery.data?.firstPlanCreatedAt == null && !!homeQuery.data;

  // D-WS5-033 — usePlans is the canonical server plan source for the grocery
  // fallback disambiguation (NOT useApp().plans, the legacy cache).
  const plansQuery = usePlans(["my_plans"]);

  // Tried & True rail — fetch the lead badges (Hosting → Featured → Top Rated),
  // cache-shared with the Plans tab (same pattern the retired PlanDiscoveryCard
  // used). Ordering/flatten is buildTriedTrueRail's job, not the card's.
  const hostingQuery = usePlans(["hosting_events"]);
  const featuredQuery = usePlans(["featured"]);
  const topRatedQuery = usePlans(["top_rated"]);
  const railItems = useMemo(
    () =>
      buildTriedTrueRail([
        { badge: TRIED_TRUE_BADGES[0], plans: hostingQuery.data?.plans ?? [] },
        { badge: TRIED_TRUE_BADGES[1], plans: featuredQuery.data?.plans ?? [] },
        { badge: TRIED_TRUE_BADGES[2], plans: topRatedQuery.data?.plans ?? [] },
      ]),
    [hostingQuery.data, featuredQuery.data, topRatedQuery.data],
  );

  // Tried & True cards are catalog templates → the vetted preview-then-use flow
  // (identical to the retired PlanDiscoveryCard).
  const preview = useTemplatePreview();
  const handleUseFromPreview = async (templateId: string) => {
    const { instanceId } = await useTemplateAsPlan(templateId);
    router.push({ pathname: "/plan/[id]", params: { id: instanceId } });
  };

  // ── Make lane: Tell Kiwi ────────────────────────────────────────────────
  const [tellText, setTellText] = useState("");
  const handleTellSubmit = () => {
    if (isLocked) return router.push("/upgrade");
    // Free text → tellkiwi.tsx (PRD §6). The text rides along as a param so it
    // survives the navigation (tellkiwi seeds its input from it, WS9 3a seam).
    router.push({ pathname: "/tellkiwi", params: { text: tellText.trim() } });
  };
  // Chip interims (both real, working destinations). /wizard already hydrates
  // from stored preferences on mount (review-then-generate).
  // TODO(3c): ✦ Surprise me → the Surprise-me generation path (§7.6).
  const handleSurprise = () =>
    router.push(isLocked ? "/upgrade" : "/wizard");
  // TODO(3c): Use my preferences → wizard PREFILLED via explicit param (§7.2).
  const handleUsePreferences = () =>
    router.push(isLocked ? "/upgrade" : "/wizard");

  // ── Tonight strip routing (branch by model.kind — the strip is dumb) ─────
  const stripPlanId =
    heroModel.kind === "today" || heroModel.kind === "plan"
      ? heroModel.planId
      : null;
  const todayMealId = heroModel.kind === "today" ? heroModel.meal.id : null;
  const handleStripPress = () => {
    if (stripPlanId) {
      router.push({ pathname: "/plan/[id]", params: { id: stripPlanId } });
    }
  };
  // G6 (verified-only) — Cook Mode is the existing /cook-session route.
  const handleCook = todayMealId
    ? () =>
        router.push({
          pathname: "/cook-session",
          params: { mealId: todayMealId },
        })
    : undefined;

  // ── Utility row: R4 grocery smart-route ─────────────────────────────────
  // active plan has list → open · plan-no-list → generate · no plan → wizard
  // (2+ plans, none active → picker). See resolveGroceryRoute.
  const handleGroceryPress = () => {
    const route = resolveGroceryRoute(
      homeQuery.data?.activePlan ?? null,
      plansQuery.data?.plans ?? [],
    );
    switch (route.kind) {
      case "open":
        router.push({
          pathname: "/grocery-list/[id]",
          params: { id: route.listId },
        });
        break;
      case "generate":
        void generateGroceries(route.planId);
        break;
      case "picker":
        router.push("/grocery-plan-picker");
        break;
      case "wizard":
        router.push("/wizard");
        break;
    }
  };
  const handlePrepAndCookPress = () => router.push("/prep-cook");

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <HomeHeader />
      <Screen>
        {isFirstRun && (
          <View style={styles.arcWrap}>
            <TeachingArc />
          </View>
        )}

        {/* Make lane */}
        <SectionLabel
          label={isFirstRun ? "what do you want to eat?" : "plan something new"}
          first
        />
        <TellKiwiCard
          value={tellText}
          onChangeText={setTellText}
          onSubmit={handleTellSubmit}
          onSurprise={handleSurprise}
          onUsePreferences={handleUsePreferences}
        />

        {/* Tonight strip — below the make lane (spec §5.1). Hidden on the empty
            state: the make lane + arc already own the "no plan yet" prompt. */}
        {heroModel.kind !== "empty" && (
          <View style={styles.stripWrap}>
            <ActivePlanStrip
              model={heroModel}
              onPress={handleStripPress}
              onCook={handleCook}
            />
          </View>
        )}

        {/* Take lane — Tried & True rail */}
        {railItems.length > 0 && (
          <>
            <SectionLabel label="tried & true" />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
            >
              {railItems.map((item) => (
                <TriedTrueCard
                  key={item.id}
                  image={item.image ? { uri: item.image } : null}
                  occasion={item.occasion}
                  title={item.title}
                  meta={item.meta ?? undefined}
                  onPress={() => preview.open(item.id)}
                />
              ))}
            </ScrollView>
          </>
        )}

        {/* Utility row (secondary — must never compete with the lanes). R4
            demotes grocery to a post-plan shopping tool, not a planning entry. */}
        <View style={styles.utilityRow}>
          <Pressable
            onPress={handleGroceryPress}
            style={({ pressed }) => [styles.secBtn, pressed && styles.secBtnPressed]}
          >
            <Text style={styles.secBtnText}>Grocery List</Text>
          </Pressable>
          <Pressable
            onPress={handlePrepAndCookPress}
            style={({ pressed }) => [styles.secBtn, pressed && styles.secBtnPressed]}
          >
            <Text style={styles.secBtnText}>Prep &amp; Cook</Text>
          </Pressable>
        </View>
      </Screen>

      <PlanPreviewModal
        visible={preview.visible}
        templateId={preview.templateId}
        onClose={preview.close}
        onUsePlan={handleUseFromPreview}
      />
      {/* D-WS5-033 — 1-plan direct generate (5-15s AI pipeline) loading cover. */}
      <GroceryGeneratingOverlay visible={isGenerating} />
    </View>
  );
}

const styles = StyleSheet.create({
  arcWrap: {
    marginTop: Spacing[3],
  },
  stripWrap: {
    marginTop: Spacing[3],
  },
  rail: {
    gap: Spacing[3],
    paddingBottom: Spacing[1],
  },
  utilityRow: {
    flexDirection: "row",
    gap: Spacing[3],
    marginTop: Spacing[5],
  },
  secBtn: {
    flex: 1,
    backgroundColor: Palette.background.card,
    borderWidth: 1.2,
    borderColor: Palette.border.strong,
    // Radius.lg (12px) per mockup .secbtn (D-WS9-025 — mockup = composition authority).
    borderRadius: Radius.lg,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  secBtnPressed: {
    backgroundColor: Colors.neutral[200],
  },
  secBtnText: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
