// Row 9 (1.1) · Stripe S2 Part D — Stripe's `success_url`.
//
// `<BILLING_RETURN_URL_BASE>/billing/return?session_id=…`, set by
// routes/billing.ts. Reached only on WEB: the native flow opens the system
// browser, so an iOS or Android user lands here in Safari or Chrome and comes
// back to the app by hand — which is why the copy tells them to.
//
// 🔴 THIS PAGE PROVES NOTHING, AND SAYS SO BY WHAT IT DOES NOT DO. It does not
// write subscription state, it does not read `session_id`, and it does not treat
// its own existence as evidence of payment. A user can open this URL by hand,
// bookmark it, or reach it after a checkout that Stripe later declined. The
// webhook is the truth (routes/billing.ts has no write path for subscription
// state precisely so that stays true), so all this page does is REFETCH and let
// the answer come from the server.
//
// It is deliberately confident in its wording anyway ("You're all set"), because
// the normal case is that the webhook landed before the redirect finished, and
// hedging at 99% would make the 99% feel broken. The 1% is handled by the sheet's
// "Finishing up…" window (lib/billing/awaitingCheckout.ts), which the user sees
// when they get back to the app rather than here.
//
// PUBLIC — no auth gate. The visitor may have signed in on web and may not have;
// either way bouncing them off Stripe's own return URL to a sign-in screen is the
// worst possible landing. Home's gate handles a signed-out visitor when they tap
// through, and it does it with context this page does not have.

import { useRouter } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Spacing, Typography } from "@/constants/tokens";
import { useBilling } from "@/contexts/BillingContext";
import { RETURN_BODY, RETURN_HOME_CTA, RETURN_TITLE } from "@/lib/billing/copy";

export default function BillingReturnPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { refetch } = useBilling();

  // The one action this page takes. `refetch` is a no-op for a visitor with no
  // session (the query is disabled), so this is safe on the public route.
  React.useEffect(() => {
    refetch();
  }, [refetch]);

  return (
    <View style={[s.wrap, { paddingTop: insets.top + Spacing[6] }]} testID="billing-return">
      <Text style={s.title}>{RETURN_TITLE}</Text>
      <Text style={s.body}>{RETURN_BODY}</Text>
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
