// Row 9 (1.1) · Stripe S2 Part D — ONE SHEET, THREE ENTRY POINTS, TWO STATES.
//
// The three ways in are a 402 (lib/api/client.ts), a tap (a banner, the Settings
// row) and an upsell moment — and all three go through BillingContext, so this
// component has one input: `sheet`. That is what makes "the paywall never traps"
// checkable rather than hopeful: there is one sheet, it has one dismiss path, and
// both states use it.
//
// 🔴 THE SHEET NEVER TRAPS. D-WS9-270 §4: the post-trial state is READ-ONLY, NOT
// LOCKED. "Not now" exists in the lapsed state as much as in the trial one, tap-
// outside closes, and the hardware back button closes — because everything the
// user saved is still readable behind this sheet and a paywall that blocks the
// door would be lying about that.
//
// Built on GuestDoorSheet's shape (the same Modal + backdrop + handle + benefit
// list), because it is the same kind of object doing the same job one tier up, and
// the two reading differently would be a design accident rather than a decision.
// The copy is entirely in lib/billing/copy.ts (§2.2 — Hans owns it).

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useBilling } from "@/contexts/BillingContext";
import {
  SHEET_BENEFITS,
  SHEET_CHECK_AGAIN,
  SHEET_FINISHING,
  SHEET_LAPSED_BODY,
  SHEET_LAPSED_TITLE,
  SHEET_PRICE_ANNUAL,
  SHEET_PRICE_MONTHLY,
  SHEET_SECONDARY,
  SHEET_TRIALING_TITLE,
} from "@/lib/billing/copy";
import { payEarlyLine } from "@/lib/billing/subscriptionView";

export function PaywallSheet() {
  const {
    sheet,
    closeSheet,
    subscription,
    startCheckout,
    checkoutBusy,
    awaiting,
    linkError,
    refetch,
  } = useBilling();
  const insets = useSafeAreaInsets();
  const visible = sheet !== null;

  // The pay-early line is trialing-only and hidden at bonus 0 — both decided in
  // lib/billing/subscriptionView.ts, not here.
  const earlyLine = sheet === "trialing" ? payEarlyLine(subscription) : null;
  const title = sheet === "trialing" ? SHEET_TRIALING_TITLE : SHEET_LAPSED_TITLE;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={closeSheet}
    >
      {/* Tap-outside closes. See the header: this sheet is never a trap. */}
      <Pressable style={s.backdrop} onPress={closeSheet} testID="paywall-backdrop" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>{title}</Text>
          <Pressable onPress={closeSheet} hitSlop={12} accessibilityLabel="Close">
            <Feather name="x" size={22} color={Colors.neutral[700]} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
          {sheet === "trialing" ? (
            // The upsell: what the user keeps. Six lines, from the door sheet.
            <View style={s.list}>
              {SHEET_BENEFITS.map((line) => (
                <View key={line} style={s.row}>
                  <Feather name="check" size={16} color={Colors.sage[700]} />
                  <Text style={s.rowText}>{line}</Text>
                </View>
              ))}
            </View>
          ) : (
            // The paywall: the data is SAFE, said first.
            <Text style={s.lapsedBody}>{SHEET_LAPSED_BODY}</Text>
          )}

          {/* ── the checkout return window (§2.3) ──────────────────────────
              The webhook is the truth, so between "the browser came back" and
              "we have seen it" the sheet says what is actually happening rather
              than closing optimistically or spinning forever. */}
          {awaiting === "polling" && (
            <Text style={s.finishing} testID="paywall-finishing">
              {SHEET_FINISHING}
            </Text>
          )}
          {awaiting === "stalled" && (
            <Button
              label={SHEET_CHECK_AGAIN}
              variant="secondary"
              onPress={refetch}
              testID="paywall-check-again"
            />
          )}

          {/* The two prices. Hidden while we are waiting on a checkout that has
              already been launched — offering to start a second one there is how a
              user ends up with two subscriptions. */}
          {awaiting === "idle" && (
            <View style={s.prices}>
              <Button
                label={SHEET_PRICE_MONTHLY}
                variant="primary"
                disabled={checkoutBusy}
                onPress={() => void startCheckout("monthly")}
                testID="paywall-monthly"
              />
              <Button
                label={SHEET_PRICE_ANNUAL}
                variant="primary"
                disabled={checkoutBusy}
                onPress={() => void startCheckout("annual")}
                testID="paywall-annual"
              />
            </View>
          )}

          {earlyLine !== null && (
            <Text style={s.earlyLine} testID="paywall-pay-early">
              {earlyLine}
            </Text>
          )}

          {linkError !== null && (
            <Text style={s.error} testID="paywall-error">
              {linkError}
            </Text>
          )}

          {/* Present in BOTH states. This is the "never traps" ruling, in a button. */}
          <Button
            label={SHEET_SECONDARY}
            variant="ghost"
            onPress={closeSheet}
            testID="paywall-not-now"
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "88%",
    backgroundColor: Palette.background.card,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[300],
    marginBottom: Spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
  },
  title: {
    flex: 1,
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  body: {
    paddingTop: Spacing[3],
    paddingBottom: Spacing[4],
    gap: Spacing[3],
  },
  list: { gap: Spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
  },
  rowText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  lapsedBody: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  prices: { gap: Spacing[2] },
  earlyLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
    lineHeight: 18,
  },
  finishing: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
  },
  error: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.danger,
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 18,
  },
});
