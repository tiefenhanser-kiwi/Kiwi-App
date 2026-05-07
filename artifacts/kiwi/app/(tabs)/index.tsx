import React, { useMemo } from "react";
import {
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
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
import {
  asPlanDiscoveryFilters,
  getCurrentActivePlan,
  getTodaysMeal,
  getUserPlans,
} from "@/lib/stubs";
import {
  KColors,
  KPalette,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";
import type { ReviewMeal, UserPlanSummary } from "@/lib/types";

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function planDurationDays(plan: UserPlanSummary): number | null {
  if (!plan.weekStartDate || !plan.weekEndDate) return null;
  const start = new Date(plan.weekStartDate).getTime();
  const end = new Date(plan.weekEndDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  // +1 because the range is inclusive (e.g. Mon–Fri = 5 days, not 4).
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
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
    if (!status) return false;
    return status !== "trialing" && status !== "active";
  }, [user?.subscription?.status]);

  // PRD §4.6 — hero card cascade. Both helpers are WS5 stubs that
  // return null today; WS7 wires them to the real plan-resolution
  // API. Code below renders all three states so the WS7 swap is
  // a one-line change.
  const todaysMeal = useMemo(() => getTodaysMeal(), []);
  const activePlan = useMemo(() => getCurrentActivePlan(), []);
  const userPlans = useMemo(() => getUserPlans(), []);
  const hasAnyPlans = userPlans.length > 0;

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

  // Per PRD §4.2.6 — Get Groceries tap behavior:
  //   - has plan + has list → /groceries
  //   - has plan + no list  → /groceries (groceries tab handles empty
  //                            current-plan state and its own
  //                            list-generation flow; WS4 will refine)
  //   - no plan             → prompt user to pick or create
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

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <HomeHeader />
      <Screen>
        <View style={styles.greetingBlock}>
          <Text style={styles.greeting}>{greeting}</Text>
        </View>

        <View style={styles.heroSection}>
          <Text style={styles.heroSectionLabel}>— this week</Text>
          <HeroCard
            todaysMeal={todaysMeal}
            activePlan={activePlan}
            onPressTodaysMeal={(planId) =>
              router.push({ pathname: "/plan/[id]", params: { id: planId } })
            }
            onPressActivePlan={(planId) =>
              router.push({ pathname: "/plan/[id]", params: { id: planId } })
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
          <PlanDiscoveryCard
            defaultExpanded={!hasAnyPlans}
            initialFilters={asPlanDiscoveryFilters(user?.lastPlanDiscoveryFilters)}
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
    </View>
  );
}

type HeroCardProps = {
  todaysMeal: { meal: ReviewMeal; planId: string } | null;
  activePlan: UserPlanSummary | null;
  onPressTodaysMeal: (planId: string) => void;
  onPressActivePlan: (planId: string) => void;
  onPressEmpty: () => void;
};

function HeroCard({
  todaysMeal,
  activePlan,
  onPressTodaysMeal,
  onPressActivePlan,
  onPressEmpty,
}: HeroCardProps) {
  if (todaysMeal) {
    const { meal, planId } = todaysMeal;
    const metaParts: string[] = [];
    if (meal.estimatedTimeMinutes) {
      metaParts.push(`${meal.estimatedTimeMinutes} min`);
    }
    if (meal.caloriesPerServing) {
      metaParts.push(`${meal.caloriesPerServing} cal`);
    }
    if (meal.difficulty) {
      metaParts.push(meal.difficulty);
    }
    return (
      <Pressable
        onPress={() => onPressTodaysMeal(planId)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.heroThumbWrap}>
          {meal.imageUrl ? (
            <Image
              source={{ uri: meal.imageUrl }}
              style={styles.heroThumbImage}
            />
          ) : (
            <View style={[styles.heroThumbImage, styles.heroThumbPlaceholder]} />
          )}
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroEyebrow}>tonight</Text>
          <Text style={styles.heroTitle} numberOfLines={2}>
            {meal.title}
          </Text>
          {metaParts.length > 0 && (
            <Text style={styles.heroMeta} numberOfLines={1}>
              {metaParts.join(" · ")}
            </Text>
          )}
        </View>
      </Pressable>
    );
  }

  if (activePlan) {
    const duration = planDurationDays(activePlan);
    const metaParts: string[] = [];
    if (duration) metaParts.push(`${duration} days`);
    if (activePlan.mealCount) metaParts.push(`${activePlan.mealCount} meals`);
    return (
      <Pressable
        onPress={() => onPressActivePlan(activePlan.id)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.heroThumbWrap}>
          <View style={[styles.heroThumbImage, styles.heroThumbPlaceholder]} />
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroEyebrow}>this week</Text>
          <Text style={styles.heroTitle} numberOfLines={2}>
            {activePlan.name}
          </Text>
          {metaParts.length > 0 && (
            <Text style={styles.heroMeta} numberOfLines={1}>
              {metaParts.join(" · ")}
            </Text>
          )}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPressEmpty}
      style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.heroThumbWrap}>
        <View style={[styles.heroThumbImage, styles.heroThumbEmptyPlaceholder]} />
      </View>
      <View style={styles.heroTextCol}>
        <Text style={styles.heroEmptyTitle}>
          No meals or plans for this week yet
        </Text>
        <Text style={styles.heroEmptyCta}>Create one to get started →</Text>
      </View>
    </Pressable>
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
  heroSection: {
    marginTop: KSpacing.xs,
    marginBottom: KSpacing.md,
  },
  heroSectionLabel: {
    color: KColors.neutral[700],
    fontStyle: "italic",
    fontSize: KType.size.md,
    letterSpacing: 0.04,
    marginBottom: KSpacing.sm,
    fontFamily: "Inter_400Regular",
  },
  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderWidth: 1,
    borderColor: KPalette.border.default,
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    minHeight: 100,
  },
  heroThumbWrap: {
    width: 80,
    height: 80,
    borderRadius: KRadius.md,
    overflow: "hidden",
    backgroundColor: KColors.sage[100],
  },
  heroThumbImage: {
    width: 80,
    height: 80,
  },
  heroThumbPlaceholder: {
    backgroundColor: KColors.sage[200],
  },
  heroThumbEmptyPlaceholder: {
    backgroundColor: KColors.sage[100],
  },
  heroTextCol: {
    flex: 1,
    justifyContent: "center",
    gap: 2,
  },
  heroEyebrow: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontStyle: "italic",
    fontFamily: "Inter_400Regular",
  },
  heroTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  heroMeta: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  heroEmptyTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  heroEmptyCta: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[400],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    marginTop: 4,
  },
  ctaBlock: {
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
