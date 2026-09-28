// Row 9 (1.1) · Stripe S2 Part D — Stripe's `cancel_url`.
//
// `<BILLING_RETURN_URL_BASE>/billing/cancelled`. Reached when the user backed out
// of Checkout, which is a perfectly ordinary thing to do and must not read as a
// failure.
//
// 🔴 TWO FACTS, AND BOTH ARE REASSURANCES. "No charge was made" answers the
// question someone who abandoned a payment page actually has, and "your plans are
// right where you left them" answers the one they have not thought of yet — that
// backing out might have cost them something. There is no second attempt to sell
// here: the sheet is one tap away from Home and from every surface that opens it,
// and pitching to someone who just said no is how an app gets uninstalled.
//
// It REFETCHES anyway. Abandoning Checkout normally changes nothing, but a user
// can also reach this page after paying and then pressing back — and the server,
// not this page, is what knows which happened.
//
// PUBLIC, for the same reason as `return.tsx`: this is a URL Stripe sends people
// to, and an auth bounce on it is the worst possible landing.

import { useRouter } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Spacing, Typography } from "@/constants/tokens";
import { useBilling } from "@/contexts/BillingContext";
import { CANCELLED_BODY, CANCELLED_TITLE, RETURN_HOME_CTA } from "@/lib/billing/copy";

export default function BillingCancelledPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { refetch } = useBilling();

  React.useEffect(() => {
    refetch();
  }, [refetch]);

  return (
    <View
      style={[s.wrap, { paddingTop: insets.top + Spacing[6] }]}
      testID="billing-cancelled"
    >
      <Text style={s.title}>{CANCELLED_TITLE}</Text>
      <Text style={s.body}>{CANCELLED_BODY}</Text>
      <Button label={RETURN_HOME_CTA} onPress={() => router.replace("/")} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingHorizontal: Spacing[5],
    gap: Spacing[4],
    backgroundColor: Colors.neutral[100],
  },
  title: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  body: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
});
