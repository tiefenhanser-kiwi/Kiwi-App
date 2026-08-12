// WS9 Block 3a — the two-lane Home (flagship). Layout top→bottom (spec §5.1):
// header (owns mark · greeting · badge + avatar chip) → teaching arc (first-run
// only) → make-lane eyebrow → Tell Kiwi card → tonight strip (below the make
// lane) → Tried & True eyebrow → Tried & True rail → utility row.
//
// This screen supplies ROUTING to the dumb Layer-2b primitives (TellKiwiCard,
// ActivePlanStrip, TriedTrueCard, SectionLabel, TreatedImage) and owns the
// ordering the cards don't.
//
// The pre-3a home's HeroCard / WizardCtaCard x2 / CookNowCtaCard /
// PlanDiscoveryCard / HomeActionButton were unmounted in 3a and DELETED in
// WS9-2 2c Commit 6 — they had sat in components/ with zero importers since,
// two of them still certified by green tests.

import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { ActivePlanStrip } from "@/components/ActivePlanStrip";
import { GroceryGeneratingOverlay } from "@/components/GroceryGeneratingOverlay";
import { HomeHeader } from "@/components/HomeHeader";
import { LoadingShim } from "@/components/LoadingShim";
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
import { useHomeRail } from "@/hooks/useHomeRail";
import { usePlans } from "@/hooks/usePlans";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useTemplatePreview } from "@/hooks/useTemplatePreview";
import { resolveGroceryRoute } from "@/lib/groceryPicker";
import { deriveHeroModel } from "@/lib/home/heroState";
import { homeSectionOrder } from "@/lib/home/homeSections";
import { buildRailItems } from "@/lib/home/rail";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();
  const { useTemplateAsPlan, setPlanActiveThisWeek } = useApp();
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

  // WS9-2 2c Commit 2 — first-load only. React Query's isLoading is
  // (pending && fetching), so a background refetch driven by useRefetchOnFocus
  // does NOT re-show the placeholder once data exists; the lead only goes
  // neutral when we genuinely have nothing to render from.
  const isHomeLoading = homeQuery.isLoading;

  // D-WS5-033 — usePlans is the canonical server plan source for the grocery
  // fallback disambiguation (NOT useApp().plans, the legacy cache).
  const plansQuery = usePlans(["my_plans"]);

  // Tried & True rail — ONE ordered read (WS9-2 2c, D-WS9-154). Replaces the
  // three per-badge usePlans calls that used to be merged client-side; the
  // server now owns membership (railPosition non-null) and order
  // (railPosition ASC, createdAt DESC). buildRailItems is display mapping only
  // and deliberately does NOT re-sort — curation is a data decision.
  const railQuery = useHomeRail();
  const railItems = useMemo(
    () => buildRailItems(railQuery.data ?? []),
    [railQuery.data],
  );

  // Tried & True cards are catalog templates → the vetted preview-then-use flow.
  const preview = useTemplatePreview();
  // BUG-036 fix: "Use This Week" creates the instance AND activates it for the
  // current week via the shared setPlanActiveThisWeek (dates + activatedAt +
  // server demotes the prior winner) — so the plan resolves as this-week and
  // Home's tonight strip renders instead of a dead screen. "Save for Later"
  // creates the undated draft only (prior behavior). Both then navigate.
  const handleUseFromPreview = async (
    templateId: string,
    opts: { activate: boolean },
  ) => {
    const { instanceId } = await useTemplateAsPlan(templateId);
    if (opts.activate) {
      await setPlanActiveThisWeek(instanceId);
    }
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
  // ✦ Surprise me (WS9 3c §7.6) → zero-typing instant plan. Lands on
  // wizard-results in "surprise" mode, which fires the generation on mount and
  // renders the standard 3-candidate cards (Ruling 1). R5's "Use this plan"
  // then applies unchanged.
  const handleSurprise = () =>
    router.push(
      isLocked
        ? "/upgrade"
        : { pathname: "/wizard-results", params: { source: "surprise" } },
    );
  // Use my preferences → the Set-Prefs wizard, which already hydrates from
  // stored preferences on mount (D-WS9-014 pt 1, verified shipped via
  // hydrateForm — review-then-generate, no explicit param needed).
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

  // WS9-2 2c Commit 6 — ONE narrowing drives both the section gate and the
  // strip's prop. ActivePlanStrip's model type now EXCLUDES the empty state
  // (that branch was unreachable and was deleted), so the compiler enforces
  // what homeSectionOrder already guaranteed: no this-week section, no strip.
  const activeHeroModel = heroModel.kind === "empty" ? null : heroModel;
  const hasActivePlan = activeHeroModel !== null;

  // Section order is the ruled contract (D-WS9-025) — mockup composition: the
  // LEAD (loading placeholder / arc first-run / tonight strip returning) sits
  // ABOVE the make-lane eyebrow. Driven by homeSectionOrder so the order lives
  // in one tested place, not reshuffleable JSX.
  const sections = homeSectionOrder({
    isFirstRun,
    hasActivePlan,
    hasRail: railItems.length > 0,
    isLoading: isHomeLoading,
  });
  // The make-lane eyebrow takes its tight top margin only when it genuinely
  // LEADS the screen. Derived from the computed order rather than re-deriving
  // the condition, so a new lead section can never drift out of sync with it
  // (the loading placeholder is a lead too).
  const makeLaneLeads = sections[0] === "makeLane";

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <HomeHeader />
      <Screen>
        {sections.map((section) => {
          switch (section) {
            case "leadLoading":
              // WS9-2 2c Commit 2 — holds the LEAD slot while GET /home is in
              // flight. Before this, the slot collapsed and Home read as
              // "you have no plan this week" for the whole request — a false
              // statement, not merely a missing one.
              //
              // Deliberately NOT a "this week" eyebrow: we do not yet know
              // whether there IS a this-week plan, and labelling the slot
              // would substitute one wrong claim for another.
              //
              // §27.2 — reuses the shared LoadingShim; no new primitive.
              return (
                <View key="leadLoading" style={styles.leadLoadingWrap}>
                  <LoadingShim variant="inline" label="Getting your week…" />
                </View>
              );
            case "arc":
              return (
                <View key="arc" style={styles.arcWrap}>
                  <TeachingArc />
                </View>
              );
            case "thisWeek":
              // The this-week MODULE: eyebrow + tonight strip + utility row. The
              // utility row lives here (not a standalone section) so it is
              // structurally impossible to render without a plan (G5), and its
              // actions sit in the context of the plan they act on.
              return (
                <View key="thisWeek" style={styles.thisWeekBlock}>
                  <SectionLabel label="this week" first />
                  {activeHeroModel ? (
                    <ActivePlanStrip
                      model={activeHeroModel}
                      onPress={handleStripPress}
                      onCook={handleCook}
                    />
                  ) : null}
                  {/* Secondary — must never compete with the lanes (G2);
                      terracotta stays unspent. R4: grocery is a post-plan
                      shopping tool, not a planning entry. */}
                  <View style={styles.utilityRow}>
                    <Pressable
                      onPress={handleGroceryPress}
                      style={({ pressed }) => [
                        styles.secBtn,
                        pressed && styles.secBtnPressed,
                      ]}
                    >
                      <Feather
                        name="shopping-bag"
                        size={20}
                        color={Colors.sage[700]}
                      />
                      <Text style={styles.secBtnText}>Grocery List</Text>
                    </Pressable>
                    <Pressable
                      onPress={handlePrepAndCookPress}
                      style={({ pressed }) => [
                        styles.secBtn,
                        pressed && styles.secBtnPressed,
                      ]}
                    >
                      <Feather
                        name="clipboard"
                        size={20}
                        color={Colors.sage[700]}
                      />
                      <Text style={styles.secBtnText}>Prep &amp; Cook</Text>
                    </Pressable>
                  </View>
                </View>
              );
            case "makeLane":
              // The eyebrow labels the Tell Kiwi card and switches by state.
              // `first` (tight top) only when it leads — i.e. no this-week
              // module above it (first-run, arc-led).
              return (
                <React.Fragment key="makeLane">
                  <SectionLabel
                    label={
                      isFirstRun
                        ? "what do you want to eat?"
                        : "plan something new"
                    }
                    first={makeLaneLeads}
                  />
                  <TellKiwiCard
                    value={tellText}
                    onChangeText={setTellText}
                    onSubmit={handleTellSubmit}
                    onSurprise={handleSurprise}
                    onUsePreferences={handleUsePreferences}
                  />
                </React.Fragment>
              );
            case "rail":
              return (
                <React.Fragment key="rail">
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
                </React.Fragment>
              );
          }
        })}
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

// ⚠️ WS9-2 2c Commit 4 (§4.3) — THE LEAD BLOCKS CONTRIBUTE NO BOTTOM MARGIN.
//
// The measured problem was 28px of dead space mid-screen, between the utility
// row and the make-lane eyebrow. It was not one oversized value; it was two
// stacking: thisWeekBlock.marginBottom (12) + SectionLabel's own marginTop (16).
// RN has no margin collapse, so they summed.
//
// Every section below the lead opens with a SectionLabel, so SectionLabel's
// marginTop is now the SINGLE OWNER of every inter-section gap (16px). Do not
// re-add marginBottom to arcWrap / leadLoadingWrap / thisWeekBlock — it would
// silently restore the double-count.
//
// NOT touched: Screen's `paddingBottom: insets.bottom + 24`. It is shared by all
// four tabs and belongs to 3g.
const styles = StyleSheet.create({
  // Lead slot sits at the top of the body (Screen supplies the top padding).
  arcWrap: {},
  // The loading placeholder occupies the same lead slot as arcWrap /
  // thisWeekBlock, so resolving the query swaps the content in place instead of
  // shoving the make lane around.
  leadLoadingWrap: {
    paddingVertical: Spacing[3],
    alignItems: "center",
  },
  // The this-week module (eyebrow + strip + utility row) as one grouped block.
  thisWeekBlock: {},
  rail: {
    gap: Spacing[3],
    paddingBottom: Spacing[1],
  },
  // Grouped directly under the strip inside the this-week module (small gap,
  // NOT the old bottom-of-screen spacing).
  utilityRow: {
    flexDirection: "row",
    gap: Spacing[3],
    marginTop: Spacing[2],
  },
  secBtn: {
    flex: 1,
    flexDirection: "row",
    gap: Spacing[2],
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
    // All-sage (label + icon) — reads finished, still secondary to the filled
    // sage card (this is a white outlined button). Terracotta stays unspent (G2).
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
