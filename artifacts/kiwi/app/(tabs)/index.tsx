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
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

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
import { useToast } from "@/contexts/ToastProvider";
import { useHomePayload } from "@/hooks/useHomePayload";
import { useHomeRail } from "@/hooks/useHomeRail";
import { usePlans } from "@/hooks/usePlans";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useTemplatePreview } from "@/hooks/useTemplatePreview";
import { deriveHeroModel } from "@/lib/home/heroState";
import { homeSectionOrder } from "@/lib/home/homeSections";
import {
  ADD_OWN_MEALS_TOAST,
  shouldOfferAddOwnMeals,
} from "@/lib/home/makeLaneOptions";
import { buildRailItems } from "@/lib/home/rail";
import { generateGroceryListForPlan } from "@/lib/api/grocery";
import { dispatchGenerateResult } from "@/lib/groceryHandoff";
import { buildCookSessionParams } from "@/lib/cooking/cookSession";
import { Colors, Spacing } from "@/constants/tokens";

export default function HomeTab() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { useTemplateAsPlan, setPlanActiveThisWeek } = useApp();
  const { showToast } = useToast();

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

  // Prefetch AND, as of 2e, this screen's saved-plan count.
  //
  // The query key ["plans","list",["my_plans"]] is SHARED with three live
  // consumers, so issuing it here warms all of them:
  //   • the Plans tab            (app/(tabs)/plans.tsx)
  //   • the Prep & Cook hub      (app/prep-cook.tsx)
  //   • AddMealToPlanSheet       (components/AddMealToPlanSheet.tsx)
  //
  // ⚠️ IT NOW HAS A READER — see hasNoSavedPlans below. The long-standing
  // "deliberate prefetch with no reader, do not sweep" warning is retired: the
  // call is load-bearing for the make lane's third option, not just a cache
  // warm. Removing it now breaks a visible feature, not only a latency win.
  const myPlans = usePlans(["my_plans"]);

  // §4.5 — "Add my own meals" renders ONLY when the user has NO SAVED PLANS.
  //
  // ⚠️ THIS IS NOT `isFirstRun`. firstPlanCreatedAt is a permanent stamp — once
  // set it is never cleared — so a user who creates a plan and composts it is
  // no longer "first run" while having zero saved plans. That user is exactly
  // who needs this option, and gating on isFirstRun would hide it from them.
  //
  // `my_plans` excludes soft-deleted rows server-side (planQueries: the
  // isArchived:false gate), so length === 0 genuinely means "nothing saved",
  // post-compost included.
  //
  // ⚠️ SUPPRESS WHILE UNKNOWN (ruled). While the query is in flight `data` is
  // undefined — that is "we don't know yet", not "zero". The decision lives in
  // lib/home/makeLaneOptions so it can be pinned by a test; this screen is
  // outside the test glob and must not re-derive it inline.
  const hasNoSavedPlans = shouldOfferAddOwnMeals(myPlans.data?.plans.length);

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
  // §4.5 — Add my own meals → the meal builder, the SAME zero-param push the
  // Meals tab uses (app/(tabs)/meals.tsx handleAddMeal), which lands on the
  // mode picker.
  //
  // ⚠️ DELIBERATELY NOT PAYWALLED. The two actions above route to /upgrade when
  // locked because they trigger AI GENERATION. Manual meal entry is not
  // generation, and the Meals tab does not gate it — gating it here would be a
  // bug, and a nasty one: it would tell a lapsed user they cannot type in a
  // recipe they own.
  //
  // The toast is fired BEFORE the push on purpose. The app-level ToastProvider
  // lives above the navigator specifically so a toast shown right before a
  // route change survives the transition with its timer running (the same
  // property compost-with-undo relies on), so this lands ON the builder screen.
  const handleAddOwnMeals = () => {
    showToast({ message: ADD_OWN_MEALS_TOAST });
    router.push("/meal-builder");
  };

  // ── Tonight strip routing (branch by model.kind — the strip is dumb) ─────
  const stripPlanId =
    heroModel.kind === "today" || heroModel.kind === "plan"
      ? heroModel.planId
      : null;
  const handleStripPress = () => {
    if (stripPlanId) {
      router.push({ pathname: "/plan/[id]", params: { id: stripPlanId } });
    }
  };
  // G6 (verified-only) — Cook Mode is the existing /cook-session route.
  //
  // BUG-105 — pass planId + planItemId. This pushed `{ mealId }` alone, so the
  // cook screen's resolvePrepGate ran with hasPlanContext=false, returned
  // "unknown", and asked "Did you prep this already?" about a plan that already
  // knows — `isPrepped` is on the wire and typed (PlanDetailItemSchema).
  //
  // The ids were already plumbed and simply never spent: HeroModel.today has
  // carried both since 3a, and handleOpenTodaysMeal directly below spends them.
  // Same instance-not-class miss BUG-091 had here.
  //
  // REUSE: buildCookSessionParams is the shared, already-tested builder for this
  // exact launch (app/meal/[id].tsx uses it; its "never fabricate a planItemId"
  // rule is pinned in lib/cooking/__tests__/cookSession.test.ts). Hand-rolling
  // the object literal here would have been a fourth copy of the same shape.
  const handleCook =
    heroModel.kind === "today"
      ? () =>
          router.push({
            pathname: "/cook-session",
            params: buildCookSessionParams({
              mealId: heroModel.meal.id,
              planId: heroModel.planId,
              planItemId: heroModel.planItemId,
            }),
          })
      : undefined;
  // BUG-091 — tapping the card's meal block opens the PLAN-INSTANCE meal
  // detail. Same route + param shape PlanReviewMealRow already uses, so both
  // entry points land on the same screen in the same plan context.
  //
  // The ids were already plumbed and simply never spent: HeroModel.today has
  // carried planItemId since 3a with a comment saying it exists "so the today
  // card opens Meal Detail with full plan-item context".
  //
  // ⚠️ servingsOverride is NOT passed — it is not on MealListItem, so Home has
  // no access to it. Meal Detail resolves plan context server-side via
  // useMeal(mealId, planItemId), so the stepper should still seed from the
  // plan's value; that is the one behavioural difference from the Plan Review
  // call site and it is a device-test item.
  const handleOpenTodaysMeal =
    heroModel.kind === "today"
      ? () =>
          router.push({
            pathname: "/meal/[id]",
            params: {
              id: heroModel.meal.id,
              planId: heroModel.planId,
              planItemId: heroModel.planItemId,
            },
          })
      : undefined;

  // ── WS9-2 2e Part 4 Item 3 — the this-week card's 2×2 action panel ────────
  //
  // ⚠️ These three handlers RE-ADD what 2c Commit 7 §7.5 removed from Home, and
  // that reversal is ruled. §7.5's reasoning was that Grocery list is
  // plan-level and Prep & Cook duplicated Start cooking — true while they were
  // loose buttons in a row that pointed at nothing in particular. The card is
  // now explicitly a panel FOR THE PLAN, so plan-level is exactly what belongs.
  //
  // ⚠️ DELIBERATELY NOT PAYWALLED, matching the pre-existing rule at the top of
  // this file: isLocked routes the MAKE-lane actions to /upgrade because they
  // trigger AI generation; grocery / prep / cook have always stayed ungated.

  // §27.2 — the SAME request path and the SAME shared result mapper Plan Review
  // uses (generateGroceryListForPlan → dispatchGenerateResult). The six-outcome
  // error ladder lives in lib/groceryHandoff.ts and is tested there; re-inlining
  // a second copy here is precisely the drift 2c Commit 10 retired.
  const [isGeneratingList, setIsGeneratingList] = useState(false);
  const handleStripGroceryList = async () => {
    if (!stripPlanId || isGeneratingList) return;
    setIsGeneratingList(true);
    try {
      const result = await generateGroceryListForPlan(stripPlanId);
      const action = dispatchGenerateResult(result, {
        navigate: (id) =>
          router.push({ pathname: "/grocery-list/[id]", params: { id } }),
        alert: (title, message) => Alert.alert(title, message),
      });
      // BUG-111 — see the twin at app/plan/[id].tsx. A successful generate
      // invalidated nothing, so the Groceries tab (60s staleTime, focus-refetch
      // gated on isStale) did not show a list the user had just made, and
      // Home's activePlan.groceryListId stayed null. Gated on the navigate
      // outcome so an error alert costs no refetches.
      if (action.kind === "navigate") {
        queryClient.invalidateQueries({ queryKey: ["groceries"] });
        queryClient.invalidateQueries({ queryKey: ["home"] });
      }
    } finally {
      setIsGeneratingList(false);
    }
  };

  // WS7-8b B2 — plan-context entry: the Prep & Cook hub for this plan. The
  // plan state's contextual first cell (the today state's is Start Cooking).
  const handleStripPrepAndCook = () => {
    if (!stripPlanId) return;
    router.push({ pathname: "/prep-cook", params: { id: stripPlanId } });
  };

  // D-WS9-158 — the Order Online STUB, byte-matching Plan Review's copy. It
  // ships styled as a full peer cell because 2e styles for the destination
  // state; the Instacart work makes it function later.
  // ⚠️ This is the STUB. "Grocery List" above is the working navigation — never
  // conflate them (D-WS9-133).
  const handleStripOrderOnline = () =>
    Alert.alert(
      "Coming soon — you'll be able to send this list to a grocery service.",
    );

  // ⚠️ WS9-2 2c Commit 7 §7.5 — the Grocery list / Prep & Cook utility row is
  // GONE from Home, and with it this screen's handleGroceryPress /
  // handlePrepAndCookPress handlers. Ruled, not an oversight: on the today
  // state Grocery list is a plan-level action and Prep & Cook duplicated Start
  // cooking's intent; consistency carries the removal to the plan state.
  //
  // ⚠️ WS9-2 2e Part 4 Item 3 — §7.5 IS REVERSED. Both actions are back, as
  // CELLS OF THE THIS-WEEK CARD'S OWN 2×2 PANEL (handleStripGroceryList /
  // handleStripPrepAndCook above), not as a loose utility row. What changed is
  // the container, and that is what the original reasoning turned on: the
  // buttons were removed because nothing tied them to a plan, and the panel is
  // now explicitly a panel FOR the plan named directly above it. Prep & Cook is
  // also no longer a sibling competing with Start cooking — they are the SAME
  // SLOT on two mutually exclusive states.
  //
  // Prep & Cook is ONE tap from Home again, not two.
  //
  // WHAT ELSE REACHES THEM (verified, not assumed):
  //   • Grocery list  → the Groceries tab (a first-class tab), and Plan
  //                     Review's own "Grocery List" action.
  //   • Prep & Cook   → Plan Review's "Prep and Cook" primary action
  //                     (app/plan/[id].tsx), and the "Start Prep & Cook →"
  //                     CTA at the end of a grocery list.
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
                      onPrepAndCook={handleStripPrepAndCook}
                      onGroceryList={handleStripGroceryList}
                      groceryLoading={isGeneratingList}
                      onOrderOnline={handleStripOrderOnline}
                      onOpenMeal={handleOpenTodaysMeal}
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
                    onAddOwnMeals={handleAddOwnMeals}
                    showAddOwnMeals={hasNoSavedPlans}
                  />
                </React.Fragment>
              );
            case "rail":
              return (
                <React.Fragment key="rail">
                  {/* BUG-087 — lowercase, matching Home's other eyebrows
                      ("this week", "what do you want to eat?").
                      ⚠️ A STRING EDIT AT THE CALL SITE, deliberately. The
                      Home-lowercase / detail-screen-Title-case split is a real
                      convention and stays: SectionLabel is shared with 8
                      Title-case renders on dish detail, meal detail and
                      meal-builder. A textTransform on the primitive would
                      lowercase "Ingredients", "Recipe steps" and "Notes
                      (optional)" on three screens this block never touches —
                      and SectionLabel's test asserts CHILDREN equal the raw
                      string, so it would catch a content transform but sail
                      straight past a style-level one. */}
                  <SectionLabel label="featured plans" />
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
    // BUG-086 — sever the stretch coupling explicitly. A horizontal ScrollView's
    // content container is a flex ROW, and Yoga's default align-items is
    // `stretch`, so every card was being pulled to the height of the tallest
    // one — that is the mechanism that turned one short card into a column of
    // dead white space inside its own border.
    //
    // FeaturedPlanCard's reserved slots already make the cards equal, so this
    // changes nothing today. It is here so that if they ever DO diverge, the
    // rail goes visibly ragged (a bug someone fixes) instead of silently
    // padding the short ones (a bug that shipped once already).
    alignItems: "flex-start",
  },
});
