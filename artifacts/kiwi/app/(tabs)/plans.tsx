import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KFeatures, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/mockData";

export default function PlansTab() {
  const router = useRouter();
  const { plans, currentPlanId, setCurrentPlan, isPremium } = useApp();

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Plans" subtitle={`${plans.length} saved`} />
      <Screen>
        <Card padded onPress={() => router.push("/wizard")}>
          <Action
            icon="zap"
            title="Kitchen Wizard"
            body="Answer a few questions and Kiwi builds a full plan."
          />
        </Card>
        <View style={{ height: KSpacing.md }} />
        <Card padded onPress={() => router.push("/tellkiwi")}>
          <Action
            icon="message-circle"
            title="Tell Kiwi"
            body="Just describe what you want — let Kiwi figure it out."
          />
        </Card>
        <View style={{ height: KSpacing.md }} />
        <Card padded onPress={() => router.push("/library")}>
          <Action
            icon="book"
            title="Browse recipes"
            body="Search the recipe library and save favorites."
          />
        </Card>

        <Text style={styles.section}>Your plans</Text>

        {!isPremium && plans.length >= KFeatures.FREE_MAX_PLANS && (
          <Card padded style={styles.upsell}>
            <Text style={styles.upsellTitle}>Free plan limit reached</Text>
            <Text style={styles.upsellBody}>
              You've saved {plans.length} of {KFeatures.FREE_MAX_PLANS} plans. Upgrade to keep cooking new ones.
            </Text>
            <Text
              style={styles.upsellLink}
              onPress={() => router.push("/upgrade")}
            >
              See Premium →
            </Text>
          </Card>
        )}

        <View style={{ gap: KSpacing.md }}>
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const previewIds = plan.meals.slice(0, 3).map((m) => m.recipeId);
            return (
              <Card
                key={plan.id}
                padded
                onPress={() => setCurrentPlan(plan.id)}
                style={isCurrent ? styles.activePlan : undefined}
              >
                <View style={styles.planRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.planName}>{plan.name}</Text>
                    <Text style={styles.planDate}>
                      Week of {formatWeek(plan.weekStart)}
                    </Text>
                    <Text style={styles.planMeals} numberOfLines={1}>
                      {previewIds
                        .map((id) => getRecipe(id)?.title)
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  {isCurrent && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>Active</Text>
                    </View>
                  )}
                </View>
              </Card>
            );
          })}
        </View>
      </Screen>
    </View>
  );
}

function Action({
  icon,
  title,
  body,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  body: string;
}) {
  return (
    <View style={styles.actionRow}>
      <View style={styles.actionIcon}>
        <Feather name={icon} size={22} color={KColors.terracotta[400]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionBody}>{body}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={KColors.neutral[600]} />
    </View>
  );
}

function formatWeek(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const styles = StyleSheet.create({
  actionRow: { flexDirection: "row", alignItems: "center", gap: KSpacing.md },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: KColors.neutral[200],
    alignItems: "center",
    justifyContent: "center",
  },
  actionTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  actionBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
  section: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    marginTop: KSpacing.xxl,
    marginBottom: KSpacing.md,
    fontFamily: "Inter_600SemiBold",
  },
  planRow: { flexDirection: "row", alignItems: "center", gap: KSpacing.md },
  planName: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  planDate: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
  planMeals: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    marginTop: 6,
    fontFamily: "Inter_400Regular",
  },
  activePlan: {
    borderColor: KColors.sage[700],
    borderWidth: 2,
  },
  badge: {
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeText: {
    color: KColors.neutral[100],
    fontSize: KType.size.xs,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  upsell: {
    backgroundColor: KColors.terracotta[50],
    borderColor: KColors.terracotta[200],
    marginBottom: KSpacing.md,
  },
  upsellTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.terracotta[700],
    fontFamily: "Inter_600SemiBold",
  },
  upsellBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    marginTop: 4,
    fontFamily: "Inter_400Regular",
  },
  upsellLink: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[600],
    fontWeight: "600",
    marginTop: KSpacing.sm,
    fontFamily: "Inter_600SemiBold",
  },
});
