// BUG-356 — DELETING AN ACCOUNT DOES NOT STOP A STORE SUBSCRIPTION.
//
// DELETE /me cancels a Stripe subscription. An App Store or Google Play one can
// only be cancelled in the store, by the person, and App Review requires the app
// to say so before the account is deleted. So the delete-account confirmation
// shows this BEFORE the confirm button, with the manage action beside it (as in
// Profile: the store's page on iOS / Android, a sentence on the web).
//
// 🔴 IT NEVER BLOCKS. It is information, not a gate: the confirm button is
// untouched and deletion proceeds when they confirm, subscribed or not.
//
// Whether it shows, and what it says, is subscriptionView.ts's
// deleteAccountNoticeFor (apple / google, entitled, not already set to end). A
// Stripe subscriber sees nothing extra — DELETE /me cancels that one.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import type { DeleteAccountNoticeView, ManageAction } from "@/lib/billing/subscriptionView";

export interface StoreSubscriptionNoticeProps {
  notice: DeleteAccountNoticeView;
  onManage: (action: ManageAction) => void;
}

export function StoreSubscriptionNotice({ notice, onManage }: StoreSubscriptionNoticeProps) {
  const manage = notice.manage;
  return (
    <View style={s.card} testID="delete-store-notice">
      <View style={s.row}>
        <Feather name="credit-card" size={18} color={Colors.terracotta[700]} />
        <Text style={s.text}>{notice.text}</Text>
      </View>
      {manage.kind === "store_link" ? (
        <Button
          label={manage.label}
          variant="secondary"
          size="sm"
          onPress={() => onManage(manage)}
          testID="delete-store-manage"
        />
      ) : manage.kind === "store_text" ? (
        <Text style={s.sub} testID="delete-store-manage-text">
          {manage.text}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[200],
    padding: Spacing[4],
    gap: Spacing[3],
  },
  row: { flexDirection: "row", gap: Spacing[2], alignItems: "flex-start" },
  text: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
    lineHeight: 20,
  },
  sub: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
});
