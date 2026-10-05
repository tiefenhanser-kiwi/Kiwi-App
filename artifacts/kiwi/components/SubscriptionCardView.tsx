// Profile → Subscription, as a renderer.
//
// Row 9 (1.1) · Stripe S2 Part E built this card inside app/(tabs)/profile.tsx;
// Resub C2 moved it here, presentational, so its two new jobs are testable:
//
//   · the "Kiwi Premium" row (C2 §2) — the purchase entry the App Review
//     account can reach during its 14-day trial, when the 402 paywall never
//     appears. It opens the sheet, which on iOS / Android sells through the store;
//   · the manage action by source (C2 §3) — the store's own page for a store
//     subscription, a sentence with no link for a Stripe one on native, the
//     Portal on the web.
//
// Which of those exist is lib/billing/subscriptionView.ts's subscriptionCardFor,
// tested over every source × platform without a React tree. This file draws it.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { PREMIUM_ROW_TITLE, SETTINGS_ROW_TITLE } from "@/lib/billing/copy";
import type { ManageAction, SubscriptionCardView as CardView } from "@/lib/billing/subscriptionView";

export interface SubscriptionCardViewProps {
  card: CardView;
  /** The Kiwi Premium row: opens the sheet in the row's state. */
  onOpenPremium: () => void;
  /** Web only: the Stripe Subscribe button (unchanged from S2). */
  onSubscribe: () => void;
  /** A store_link: open the store page. A stripe_portal: open the Portal (web). */
  onManage: (action: ManageAction) => void;
  linkError: string | null;
}

export function SubscriptionCardView({
  card,
  onOpenPremium,
  onSubscribe,
  onManage,
  linkError,
}: SubscriptionCardViewProps) {
  const manage = card.manage;
  return (
    <View style={s.card} testID="settings-subscription">
      <Text style={s.cardTitle}>{SETTINGS_ROW_TITLE}</Text>
      <Text style={s.hint} testID="settings-subscription-status">
        {card.statusLine}
      </Text>

      {card.premium !== null && (
        <Pressable
          onPress={onOpenPremium}
          accessibilityRole="button"
          accessibilityLabel={`${PREMIUM_ROW_TITLE}. ${card.premium.line}`}
          style={({ pressed }) => [s.premium, pressed && { opacity: 0.85 }]}
          testID="settings-premium"
        >
          <View style={{ flex: 1 }}>
            <Text style={s.premiumTitle}>{PREMIUM_ROW_TITLE}</Text>
            <Text style={s.premiumLine} testID="settings-premium-line">
              {card.premium.line}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={Colors.sage[700]} />
        </Pressable>
      )}

      {card.subscribe && (
        <View style={s.button}>
          <Button
            label={card.subscribeLabel}
            variant="primary"
            size="sm"
            onPress={onSubscribe}
            testID="settings-subscribe"
          />
        </View>
      )}

      {manage !== null && (manage.kind === "store_link" || manage.kind === "stripe_portal") && (
        <View style={s.button}>
          <Button
            label={manage.label}
            variant="ghost"
            size="sm"
            onPress={() => onManage(manage)}
            testID={manage.kind === "store_link" ? "settings-manage-store" : "settings-manage"}
          />
        </View>
      )}

      {manage !== null && (manage.kind === "store_text" || manage.kind === "stripe_text") && (
        <Text style={s.hint} testID="settings-manage-text">
          {manage.text}
        </Text>
      )}

      {/* The Portal's 409s and a refused store link land here rather than in an
          Alert: the honest response is a line, and BillingContext has already
          refetched. */}
      {linkError !== null && (
        <Text style={s.error} testID="settings-subscription-error">
          {linkError}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  // The profile screen's own card and title metrics, so the card reads as one of
  // its neighbours.
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  hint: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  premium: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    paddingVertical: Spacing[3],
    paddingHorizontal: Spacing[3],
    marginTop: Spacing[1],
  },
  premiumTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  premiumLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
    marginTop: 2,
  },
  button: { alignSelf: "flex-start" },
  error: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.danger,
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
});
