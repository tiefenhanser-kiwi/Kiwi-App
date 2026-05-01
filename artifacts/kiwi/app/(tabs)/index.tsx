import React, { useMemo } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";

import { CookNowCtaCard } from "@/components/CookNowCtaCard";
import { HomeActionButton } from "@/components/HomeActionButton";
import { HomeHeader } from "@/components/HomeHeader";
import { PlanDiscoveryCard } from "@/components/PlanDiscoveryCard";
import { Screen } from "@/components/Screen";
import { WizardCtaCard } from "@/components/WizardCtaCard";
import { useAuth } from "@/contexts/AuthContext";
import { useApp } from "@/contexts/AppContext";
import { KColors, KSpacing, KType } from "@/constants/tokens";

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

  const greeting = useMemo(() => {
    const tod = timeOfDayGreeting();
    const name = user?.firstName ?? "there";
    return `${tod}, ${name}`;
  }, [user?.firstName]);

  const isLocked = useMemo(() => {
    const status = user?.subscription?.status;
    // Locked when not trialing AND not active. Free-tier-post-trial path.
    if (!status) return false; // still loading — don't lock
    return status !== "trialing" && status !== "active";
  }, [user?.subscription?.status]);

  const isFirstArrival = useMemo(() => {
    const filters = user?.lastPlanDiscoveryFilters;
    return !filters || filters.length === 0;
  }, [user?.lastPlanDiscoveryFilters]);

  const handleWizardCtaPress = (route: "/wizard" | "/tellkiwi") => {
    if (isLocked) {
      // Per D-WS3-002 — simplified upgrade redirect. Modal overlay
      // deferred to WS6/pre-launch polish.
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

  // Per PRD §4.2.6 — Get Groceries tap behavior:
  //   - has plan + has list → /groceries
  //   - has plan + no list  → /groceries (groceries tab handles empty
  //                            current-plan state and its own
  //                            list-generation flow; WS4 will refine)
  //   - no plan             → prompt user to pick or create
  //
  // We don't generate the grocery list ourselves here — that's a server
  // concern WS7 wires up. For WS3, "go to groceries tab" is the right
  // routing for both "has list" and "has plan no list" cases. The empty
  // prompt is the only branch we own visually.
  const handleGetGroceriesPress = () => {
    if (isEmptyState) {
      Alert.alert(
        "Create or pick a plan first",
        "You need a meal plan before Kiwi can build your grocery list.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Use Kitchen Wizard",
            onPress: () => router.push("/wizard"),
          },
        ],
      );
      return;
    }
    router.push("/groceries");
  };

  // Per PRD §4.2.6 — Prep and Cook tap behavior:
  //   - has plan with today's meal → Cook Mode for that meal
  //   - has plan no today's meal   → Prep & Cook Hub (route to plan-results
  //                                   for now; WS5/WS6 builds the proper hub)
  //   - no plan                    → prompt user to pick or create
  //
  // WS3 doesn't have today's-meal recipe lookup wired (D-WS3-013 covers
  // that for WS7). For now we route to /plan-results when a plan exists,
  // regardless of whether today has a meal. The Prep & Cook Hub UX is
  // not built yet either; /plan-results is the closest existing screen.
  const handlePrepAndCookPress = () => {
    if (isEmptyState) {
      Alert.alert(
        "Create or pick a plan first",
        "Pick a plan or let the Kitchen Wizard build one to start cooking.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Use Kitchen Wizard",
            onPress: () => router.push("/wizard"),
          },
        ],
      );
      return;
    }
    router.push("/plan-results");
  };

  const statusText = useMemo(() => {
    if (!currentPlan) return "Ready to cook?";

    const hasAnyRealMeal =
      currentPlan.meals?.some(
        (m: { recipeId?: string }) => m.recipeId && m.recipeId !== "",
      ) ?? false;

    if (!hasAnyRealMeal) return "Ready to cook?";

    // PRD §4.2.2 specifies three states; the "Tonight's dinner: [meal title]"
    // state requires a recipe-title lookup that WS7 owns. Until then we
    // collapse to two states. See kiwi_deferred_decisions_log.md D-WS3-013.
    return `This week: ${currentPlan.name}`;
  }, [currentPlan]);

  const isEmptyState = useMemo(() => {
    if (!currentPlan) return true;
    const hasAnyRealMeal =
      currentPlan.meals?.some(
        (m: { recipeId?: string }) => m.recipeId && m.recipeId !== "",
      ) ?? false;
    return !hasAnyRealMeal;
  }, [currentPlan]);

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <HomeHeader />
      <Screen>
        <View style={styles.greetingBlock}>
          {isEmptyState ? (
            <>
              <Text style={styles.greeting}>{greeting}</Text>
              <Text style={styles.status}>
                Welcome to Kiwi! Pick a plan or let the Kitchen Wizard build
                one for you.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.greeting}>{greeting}</Text>
              <Text style={styles.status}>{statusText}</Text>
            </>
          )}
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
          <PlanDiscoveryCard
            defaultExpanded={isFirstArrival}
            initialFilters={user?.lastPlanDiscoveryFilters as any}
          />

          <View style={styles.actionRow}>
            <HomeActionButton
              icon={
                <Svg width={18} height={18} viewBox="0 0 16 16" fill="none">
                  <Path
                    d="M2 2h12l-1.5 9H3.5L2 2z"
                    fill={KColors.sage[700]}
                  />
                  <Circle cx="6" cy="14.2" r="1.2" fill={KColors.sage[700]} />
                  <Circle cx="11" cy="14.2" r="1.2" fill={KColors.sage[700]} />
                </Svg>
              }
              label="Get Groceries"
              subLabel="Send to store or print"
              onPress={handleGetGroceriesPress}
            />
            <HomeActionButton
              icon={
                <Svg width={18} height={18} viewBox="0 0 16 16" fill="none">
                  <Circle cx="8" cy="5" r="2.8" fill={KColors.sage[700]} />
                  <Path
                    d="M3 13.5c0-2.8 2.2-5 5-5s5 2.2 5 5"
                    stroke={KColors.sage[700]}
                    strokeWidth={1.3}
                    fill="none"
                    strokeLinecap="round"
                  />
                </Svg>
              }
              label="Prep and Cook"
              subLabel="Step-by-step guidance"
              onPress={handlePrepAndCookPress}
            />
          </View>
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  greetingBlock: {
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.md,
  },
  greeting: {
    fontSize: KType.size.xxl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  status: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    marginTop: KSpacing.xs,
    fontFamily: "Inter_400Regular",
  },
  ctaBlock: {
    marginTop: KSpacing.md,
    gap: KSpacing.md,
  },
  wizardRow: {
    flexDirection: "row",
    gap: KSpacing.md,
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.md,
  },
});
