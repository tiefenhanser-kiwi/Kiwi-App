import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";

import { CookNowCtaCard } from "@/components/CookNowCtaCard";
import { HeroCard } from "@/components/HeroCard";
import { HomeActionButton } from "@/components/HomeActionButton";
import { HomeHeader } from "@/components/HomeHeader";
import { PlanDiscoveryCard } from "@/components/PlanDiscoveryCard";
import { Screen } from "@/components/Screen";
import { WizardCtaCard } from "@/components/WizardCtaCard";
import { useAuth } from "@/contexts/AuthContext";
import { useApp } from "@/contexts/AppContext";
import { useHomePayload } from "@/hooks/useHomePayload";
import { usePlans } from "@/hooks/usePlans";
import { useGroceryGeneration } from "@/hooks/useGroceryGeneration";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { GroceryGeneratingOverlay } from "@/components/GroceryGeneratingOverlay";
import { decideGroceryEntry } from "@/lib/groceryPicker";
import { deriveHeroModel } from "@/lib/home/heroState";
import { Colors, Spacing, Typography } from "@/constants/tokens";

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();
  const { currentPlan } = useApp();
  // D-WS5-033 — the Get Groceries CTA fans out on plan count; usePlans is the
  // canonical server source (NOT useApp().plans, the legacy AsyncStorage cache).
  // First page is enough for the 0/1/2+ branch (limit 20 ⇒ 2+ always ≥2 rows).
  const plansQuery = usePlans(["my_plans"]);
  const { generate: generateGroceries, isGenerating } = useGroceryGeneration();

  const greeting = useMemo(() => {
    const tod = timeOfDayGreeting();
    const name = user?.firstName ?? "there";
    return `${tod}, ${name}`;
  }, [user?.firstName]);

  const isLocked = useMemo(() => {
    const status = user?.subscription?.status;
    if (!status) return false;
    return status !== "trialing" && status !== "active";
  }, [user?.subscription?.status]);

  // PRD §4.6 — Hero card cascade (today's meal → active plan → empty).
  // GET /home is the real source post-WS7-3 C2; while it loads or errors
  // deriveHeroModel collapses to the empty state (Phase 2 Commit 1 ruling).
  const homeQuery = useHomePayload();
  // WS7-6 (E) Block 2 §6 — focus-driven backstop. Precise ["home"]
  // invalidations from AppContext mutators are the primary refresh path;
  // this hook covers the case where a mutation lands while Home is in the
  // background and the focus-arrival happens after the 60s staleness gate.
  useRefetchOnFocus(homeQuery);
  const heroModel = deriveHeroModel(homeQuery.data);

  const isEmptyState = useMemo(() => {
    if (!currentPlan) return true;
    const hasAnyRealMeal =
      currentPlan.meals?.some(
        (m: { recipeId?: string }) => m.recipeId && m.recipeId !== "",
      ) ?? false;
    return !hasAnyRealMeal;
  }, [currentPlan]);

  const handleWizardCtaPress = (route: "/wizard" | "/tellkiwi") => {
    if (isLocked) {
      router.push("/upgrade");
      return;
    }
    router.push(route);
  };

  const handleCookNowPress = () => {
    if (isLocked) {
      router.push("/upgrade");
      return;
    }
    router.push("/cook-now");
  };

  // PRD §4.2.6 / D-WS5-033 — Get Groceries fans out by plan count:
  //   0 plans (or not yet loaded) → today's behavior: open the Groceries tab.
  //   1 plan  → straight to that plan's grocery flow (shared generate handoff).
  //   2+ plans → the intermediate multi-plan picker.
  const handleGetGroceriesPress = () => {
    const decision = decideGroceryEntry(plansQuery.data?.plans ?? []);
    if (decision.kind === "picker") {
      router.push("/grocery-plan-picker");
    } else if (decision.kind === "single") {
      void generateGroceries(decision.planId);
    } else {
      router.push("/(tabs)/groceries");
    }
  };

  // WS7-8b B2 — the real Prep & Cook Hub now lives at /prep-cook. Home carries
  // no plan id at this call site, so we push without one (Option A): the Hub
  // resolves "this week's" plan from the server (activeThisWeek) and shows its
  // own "no plan this week" empty state when there isn't one.
  const handlePrepAndCookPress = () => {
    router.push("/prep-cook");
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <HomeHeader />
      <Screen>
        <View style={styles.greetingBlock}>
          <Text style={styles.greeting}>{greeting}</Text>
        </View>

        <View style={styles.heroSection}>
          {/* WS7-6 (E) Block 2 §3 — section label dropped. The HeroCard
              renders its own eyebrow ("tonight" / "this week"), so the
              outer "— this week" header was either contradictory (today
              kind: "— this week" above "tonight") or duplicative (plan
              kind: "— this week" above "this week"). */}
          <HeroCard
            model={heroModel}
            onPressPlan={(planId) =>
              router.push({ pathname: "/plan/[id]", params: { id: planId } })
            }
            onPressToday={(planId, planItemId, mealId) =>
              router.push({
                pathname: "/meal/[id]",
                params: { id: mealId, planId, planItemId },
              })
            }
            onPressEmpty={() => router.push("/wizard")}
          />
        </View>

        <View style={styles.ctaBlock}>
          <View style={styles.wizardRow}>
            <WizardCtaCard
              icon="preferences"
              subLabel="Set Preferences, Get Food"
              onPress={() => handleWizardCtaPress("/wizard")}
              locked={isLocked}
            />
            <WizardCtaCard
              icon="freeform"
              subLabel="Just Say What You Want to Eat"
              onPress={() => handleWizardCtaPress("/tellkiwi")}
              locked={isLocked}
            />
          </View>
          <CookNowCtaCard
            onPress={handleCookNowPress}
            locked={isLocked}
          />
          <PlanDiscoveryCard />

          <View style={styles.actionRow}>
            <HomeActionButton
              icon={
                <Svg width={18} height={18} viewBox="0 0 16 16" fill="none">
                  <Path
                    d="M2 2h12l-1.5 9H3.5L2 2z"
                    fill={Colors.sage[700]}
                  />
                  <Circle cx="6" cy="14.2" r="1.2" fill={Colors.sage[700]} />
                  <Circle cx="11" cy="14.2" r="1.2" fill={Colors.sage[700]} />
                </Svg>
              }
              label="Get Groceries"
              subLabel={
                isEmptyState
                  ? "No grocery list yet — create a plan first."
                  : "Send to store or print"
              }
              onPress={handleGetGroceriesPress}
            />
            <HomeActionButton
              icon={
                <Svg width={18} height={18} viewBox="0 0 16 16" fill="none">
                  <Circle cx="8" cy="5" r="2.8" fill={Colors.sage[700]} />
                  <Path
                    d="M3 13.5c0-2.8 2.2-5 5-5s5 2.2 5 5"
                    stroke={Colors.sage[700]}
                    strokeWidth={1.3}
                    fill="none"
                    strokeLinecap="round"
                  />
                </Svg>
              }
              label="Prep and Cook"
              subLabel={
                isEmptyState
                  ? "Pick a recipe to start cooking."
                  : "Step-by-step guidance"
              }
              onPress={handlePrepAndCookPress}
            />
          </View>
        </View>
      </Screen>
      {/* D-WS5-033 — 1-plan direct generate (5-15s AI pipeline) loading cover. */}
      <GroceryGeneratingOverlay visible={isGenerating} />
    </View>
  );
}

const styles = StyleSheet.create({
  greetingBlock: {
    paddingTop: Spacing[4],
    paddingBottom: Spacing[3],
  },
  greeting: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serifItalic[500],
  },
  heroSection: {
    marginTop: Spacing[1],
    marginBottom: Spacing[3],
  },
  ctaBlock: {
    gap: Spacing[3],
  },
  wizardRow: {
    flexDirection: "row",
    gap: Spacing[3],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[3],
  },
});
