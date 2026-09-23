import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// D-WS9-258 — the Subscription card is REMOVED for the first binary: the state
// line, "Upgrade for unlimited features", and a "Manage subscription" button
// whose only behaviour was a "coming soon" Alert. Nothing in the app takes
// money, so nothing in it may promise a purchase. Stripe's lane re-adds the
// card here; lib/domain.ts still exports formatSubscriptionState and
// subscriptionInfoFromAuth for it to re-wire.
//
// D-WS9-257 — the danger card is DELETION now, not deactivation. The old copy
// ("Soft-deletes your account; admins restore within 6 months") described a
// restore path no user could reach and a permanent-deletion job that was never
// built. The screen it pushes to says exactly what the server does.
export default function ManageAccount() {
  const router = useRouter();

  const handleDelete = () => {
    router.push("/delete-account");
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title="Account" />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.dangerCard}>
          <Text style={s.cardTitle}>Account</Text>
          <Text style={s.dangerHeading}>Delete this account</Text>
          <Text style={s.dangerSubtitle}>
            Permanently deletes your account and everything in it. This can't be
            undone.
          </Text>
          <View style={s.primaryAction}>
            <Button
              label="Delete account"
              variant="primary"
              onPress={handleDelete}
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
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    marginBottom: Spacing[2],
  },
  primaryAction: {
    marginTop: Spacing[3],
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
