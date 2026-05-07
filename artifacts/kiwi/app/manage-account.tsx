import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { formatSubscriptionState } from "@/lib/domain";
import { getCurrentSubscription } from "@/lib/stubs";
import type { SubscriptionInfo } from "@/lib/types";

export default function ManageAccount() {
  const router = useRouter();
  const [subscription] = useState<SubscriptionInfo>(() =>
    getCurrentSubscription(),
  );

  const handleManageSubscription = () => {
    Alert.alert(
      "Coming in WS6 — Stripe integration",
      "Subscription management requires the Stripe Customer Portal. This will be wired in WS6.",
    );
  };

  const handleDeactivate = () => {
    router.push("/deactivate-account");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title="Account & Subscription" />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.card}>
          <Text style={s.cardTitle}>Subscription</Text>
          <Text style={s.subscriptionState}>
            {formatSubscriptionState(subscription)}
          </Text>
          <Text style={s.subscriptionHint}>Upgrade for unlimited features</Text>
          <View style={s.primaryAction}>
            <Button
              label="Manage subscription"
              variant="primary"
              onPress={handleManageSubscription}
            />
          </View>
        </View>

        {/* Visual gap separating destructive action from upgrade flow. */}
        <View style={s.dangerSpacer} />

        <View style={s.dangerCard}>
          <Text style={s.cardTitle}>Account</Text>
          <Text style={s.dangerHeading}>Deactivate this account</Text>
          <Text style={s.dangerSubtitle}>
            Soft-deletes your account; admins restore within 6 months. After 6
            months, permanent deletion.
          </Text>
          <View style={s.primaryAction}>
            <Button
              label="Deactivate account"
              variant="terra"
              onPress={handleDeactivate}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  cardTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    marginBottom: KSpacing.sm,
  },
  subscriptionState: {
    fontSize: KType.size.lg,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  subscriptionHint: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.xs,
  },
  primaryAction: {
    marginTop: KSpacing.md,
  },
  dangerSpacer: {
    height: KSpacing.lg,
  },
  dangerCard: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
    padding: KSpacing.md,
  },
  dangerHeading: {
    fontSize: KType.size.md,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  dangerSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.xs,
    lineHeight: 18,
  },
});
