import React, { useMemo } from "react";
import {
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
import { useHomePayload } from "@/hooks/useHomePayload";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { formatMacro } from "@/lib/format/macros";
import { deriveHeroModel, type HeroModel } from "@/lib/home/heroState";
import {
  KColors,
  KPalette,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";

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

  // PRD §4.2.6 — route to the Groceries tab. The intermediate "pick a
  // list" screen for users with multiple plans ships in WS5-5Q-bis.
  const handleGetGroceriesPress = () => {
    router.push("/(tabs)/groceries");
  };

  // WS5-5R — routes to /prep-cook stub page (matches /upgrade pattern).
  // Prep & Cook Hub workstream replaces the stub page with the real UI.
  const handlePrepAndCookPress = () => {
    router.push("/prep-cook");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
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
  model: HeroModel;
  onPressPlan: (planId: string) => void;
  onPressEmpty: () => void;
};

function HeroCard({ model, onPressPlan, onPressEmpty }: HeroCardProps) {
  if (model.kind === "today") {
    const { meal } = model;
    // MealListItem (GET /home embed) carries minutes + calories; the
    // list shape has no per-meal difficulty, so the meta line is shorter
    // than the WS5 stub's "min · cal · difficulty".
    const metaParts: string[] = [];
    if (meal.minutes) metaParts.push(`${meal.minutes} min`);
    if (meal.calories) metaParts.push(`${formatMacro(meal.calories, "0")} cal`);
    return (
      <Pressable
        onPress={() => onPressPlan(model.planId)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.heroThumbWrap}>
          {meal.image ? (
            <Image
              source={{ uri: meal.image }}
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

  if (model.kind === "plan") {
    const metaParts: string[] = [];
    if (model.durationDays) metaParts.push(`${model.durationDays} days`);
    return (
      <Pressable
        onPress={() => onPressPlan(model.planId)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.heroThumbWrap}>
          <View style={[styles.heroThumbImage, styles.heroThumbPlaceholder]} />
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroEyebrow}>this week</Text>
          <Text style={styles.heroTitle} numberOfLines={2}>
            {model.name}
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
