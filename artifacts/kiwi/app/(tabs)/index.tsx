// WS9 Block 3a — the two-lane Home (flagship). Layout top→bottom, as of
// WS9-2 2c: header (mark · greeting · badge + avatar chip) → teaching arc
// (first-run) OR this-week card (returning) OR loading placeholder →
// make-lane eyebrow → Tell Kiwi card → "Featured plans" eyebrow → rail.
//
// ⚠️ THE RAIL IS LAST. Nothing renders after it. If a future block appends a
// section below the rail, re-run the off-screen check — a variable-length list
// with content beneath it is the 2a defect class (a "Create new" card pushed
// below the fold), and this screen is currently immune only because nothing
// follows the rail.
//
// The utility button row (Grocery list · Prep & Cook) was removed in 2c Commit
// 7; the this-week card now carries its own actions.
//
// This screen supplies ROUTING to the dumb Layer-2b primitives (TellKiwiCard,
// ActivePlanStrip, FeaturedPlanCard, SectionLabel, TreatedImage) and owns the
// ordering the cards don't.
//
// The pre-3a home's HeroCard / WizardCtaCard x2 / CookNowCtaCard /
// PlanDiscoveryCard / HomeActionButton were unmounted in 3a and DELETED in
// WS9-2 2c Commit 6 — they had sat in components/ with zero importers since,
// two of them still certified by green tests.

import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { ActivePlanStrip } from "@/components/ActivePlanStrip";
import { HomeHeader } from "@/components/HomeHeader";
import { LoadingShim } from "@/components/LoadingShim";
import { PlanPreviewModal } from "@/components/PlanPreviewModal";
import { Screen } from "@/components/Screen";
import { SectionLabel } from "@/components/SectionLabel";
import { TeachingArc } from "@/components/TeachingArc";
import { TellKiwiCard } from "@/components/TellKiwiCard";
import { FeaturedPlanCard } from "@/components/FeaturedPlanCard";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useHomePayload } from "@/hooks/useHomePayload";
import { useHomeRail } from "@/hooks/useHomeRail";
import { usePlans } from "@/hooks/usePlans";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useTemplatePreview } from "@/hooks/useTemplatePreview";
import { deriveHeroModel } from "@/lib/home/heroState";
import { homeSectionOrder } from "@/lib/home/homeSections";
import { buildRailItems } from "@/lib/home/rail";
import { Colors, Spacing } from "@/constants/tokens";

export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();
  const { useTemplateAsPlan, setPlanActiveThisWeek } = useApp();

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

  // ⚠️ DELIBERATE PREFETCH — NOT DEAD CODE. DO NOT SWEEP.
  //
  // Nothing on this screen reads the result, and that is intentional. Its
  // former consumer was the Grocery list button's route fallback, which came
  // off Home in 2c Commit 7; the fallback itself (resolveGroceryRoute) was
  // deleted in Commit 10 along with the orphaned picker screen it fed.
  //
  // The call stays because the query key ["plans","list",["my_plans"]] is
  // SHARED with three live consumers, so issuing it here warms all of them:
  //   • the Plans tab            (app/(tabs)/plans.tsx)
  //   • the Prep & Cook hub      (app/prep-cook.tsx) — now a TWO-tap path from
  //     Home (this-week card → View plan → Prep and Cook), so warming it is
  //     worth MORE than when the hub had its own Home button, not less
  //   • AddMealToPlanSheet       (components/AddMealToPlanSheet.tsx)
  //
  // A future "unused query" sweep will look at this and see dead weight. It is
  // not. If it should go, that is a ruling, not a cleanup.
  usePlans(["my_plans"]);

  // Featured-plans rail — ONE ordered read (WS9-2 2c, D-WS9-154). Replaces the
  // three per-badge usePlans calls that used to be merged client-side; the
  // server now owns membership (railPosition non-null) and order
  // (railPosition ASC, createdAt DESC). buildRailItems is display mapping only
  // and deliberately does NOT re-sort — curation is a data decision.
  const railQuery = useHomeRail();
  const railItems = useMemo(
    () => buildRailItems(railQuery.data ?? []),
    [railQuery.data],
  );

  // Featured-plan cards are catalog templates → the vetted preview-then-use flow.
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

  // ⚠️ WS9-2 2c Commit 7 §7.5 — the Grocery list / Prep & Cook utility row is
  // GONE from Home, and with it this screen's handleGroceryPress /
  // handlePrepAndCookPress handlers. Ruled, not an oversight: on the today
  // state Grocery list is a plan-level action and Prep & Cook duplicated Start
  // cooking's intent; consistency carries the removal to the plan state.
  //
  // WHAT STILL REACHES THEM (verified, not assumed):
  //   • Grocery list  → the Groceries tab (a first-class tab), and Plan
  //                     Review's own "Grocery List" action.
  //   • Prep & Cook   → Plan Review's "Prep and Cook" primary action
  //                     (app/plan/[id].tsx), and the "Start Prep & Cook →"
  //                     CTA at the end of a grocery list. It is NOT a tab, so
  //                     from Home it is now TWO taps (card → View plan →
  //                     Prep and Cook) where it was one.
  //
  // Commit 10 finished the job: removing the button left resolveGroceryRoute
  // with zero callers, which in turn left app/grocery-plan-picker.tsx — its
  // only downstream screen — unreachable from anywhere in the app. Picker,
  // route helpers, useGroceryGeneration and GroceryGeneratingOverlay are all
  // deleted. The generate MAPPING survived and moved to lib/groceryHandoff.ts,
  // where Plan Review now consumes it (closes D-WS7-144).

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
              // WS9-2 2c Commit 7 — the this-week MODULE is now ONE card. The
              // actions moved INSIDE it (ActivePlanStrip owns them), because a
              // card with a sibling button row read as two unrelated objects
              // and nothing indicated the buttons acted on the plan above.
              // There is no longer a utility row on this page at all (§7.5).
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
                  <SectionLabel label="Featured plans" />
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.rail}
                  >
                    {railItems.map((item) => (
                      <FeaturedPlanCard
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
  // The this-week module: eyebrow + card. The card owns its own actions as of
  // 2c Commit 7 — there is no sibling button row here any more.
  thisWeekBlock: {},
  rail: {
    gap: Spacing[3],
    paddingBottom: Spacing[1],
  },
});
