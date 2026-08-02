import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
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
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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
              variant="primary"
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
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    marginBottom: Spacing[2],
  },
  subscriptionState: {
    fontSize: Typography.fontSize.lg,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginTop: 2,
  },
  subscriptionHint: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
  },
  primaryAction: {
    marginTop: Spacing[3],
  },
  dangerSpacer: {
    height: Spacing[4],
  },
  dangerCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[200],
    padding: Spacing[3],
  },
  dangerHeading: {
    fontSize: Typography.fontSize.md,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: 2,
  },
  dangerSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
    lineHeight: 18,
  },
});
