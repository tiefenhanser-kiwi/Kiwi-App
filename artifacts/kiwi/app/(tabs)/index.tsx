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
import { usePlans } from "@/hooks/usePlans";
import { useGroceryGeneration } from "@/hooks/useGroceryGeneration";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { GroceryGeneratingOverlay } from "@/components/GroceryGeneratingOverlay";
import { decideGroceryEntry } from "@/lib/groceryPicker";
import { formatMacro } from "@/lib/format/macros";
import { deriveHeroModel, type HeroModel } from "@/lib/home/heroState";
import {
  Colors,
  Palette,
  Radius,
  Spacing,
  Typography,
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
  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Radius.lg,
    padding: Spacing[3],
    minHeight: 100,
  },
  heroThumbWrap: {
    width: 80,
    height: 80,
    borderRadius: Radius.md,
    overflow: "hidden",
    backgroundColor: Colors.sage[100],
  },
  heroThumbImage: {
    width: 80,
    height: 80,
  },
  heroThumbPlaceholder: {
    backgroundColor: Colors.sage[200],
  },
  heroThumbEmptyPlaceholder: {
    backgroundColor: Colors.sage[100],
  },
  heroTextCol: {
    flex: 1,
    justifyContent: "center",
    gap: 2,
  },
  heroEyebrow: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[400],
  },
  heroTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  heroMeta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  heroEmptyTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  heroEmptyCta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[400],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    marginTop: 4,
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
