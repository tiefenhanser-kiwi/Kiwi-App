import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { CookNowCtaCard } from "@/components/CookNowCtaCard";
import { HomeHeader } from "@/components/HomeHeader";
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

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <HomeHeader />
      <Screen>
        <View style={styles.greetingBlock}>
          <Text style={styles.greeting}>{greeting}</Text>
          <Text style={styles.status}>{statusText}</Text>
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
});
