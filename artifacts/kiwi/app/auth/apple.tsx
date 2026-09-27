// Row 9 (1.1) · OAuth Block 2 Part D — Apple's Return URL, which the flow
// never actually uses.
//
// §3 Part D — "the /auth/apple redirect route exists and simply returns to the
// app (popup mode posts the result back; the route is Apple's requirement, not
// the flow)."
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────
//
// `AppleID.auth.init({ redirectURI })` is not optional, and Apple validates
// the value against the Return URLs registered on the Services ID before it
// will show the sheet at all. With `usePopup: true` nothing is navigated here:
// the popup posts its result back to the opener, which dispatches
// `AppleIDSignInOnSuccess` on `document`, and components/oauth/AppleWebButton
// .tsx picks it up. So this page is a registration requirement wearing the
// clothes of a callback.
//
// ── WHEN SOMEONE DOES LAND ON IT ─────────────────────────────────────────
//
// Two ways, and both end the same place. A popup blocker can force Apple into
// full-page redirect mode, and a person can paste the URL. Either way there is
// no session to build here — Apple would have POSTed its form to this URL, and
// a static web export has no server to read a POST body — so the honest answer
// is to send them back to the door they came from rather than show a spinner
// over a flow that cannot continue.
//
// 🔴 NOT a silent redirect: someone who arrives here after a real Apple
// authorisation has been signed in by Apple and NOT by Kiwi, and a bounce with
// no explanation reads as "it didn't work, and nobody noticed". One line, then
// the button they can press again.

import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Spacing, Typography } from "@/constants/tokens";

export default function AppleRedirectPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={[s.wrap, { paddingTop: insets.top + Spacing[6] }]}>
      <Text style={s.title}>Almost there</Text>
      <Text style={s.body}>
        Apple sent you back to Kiwi, but this window can&apos;t finish signing you
        in. Head back to the sign-in screen and tap Continue with Apple again —
        it usually works the second time, with pop-ups allowed for
        kitchenwizard.ai.
      </Text>
      <Button label="Back to sign in" onPress={() => router.replace("/(auth)/sign-in")} />
      <Pressable onPress={() => router.replace("/")} hitSlop={8}>
        <Text style={s.link}>Go to Kiwi</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
    paddingHorizontal: Spacing[4],
    gap: Spacing[4],
  },
  title: {
    fontSize: Typography.fontSize.xl * 1.4,
    fontWeight: "700",
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
  },
  body: {
    fontSize: Typography.fontSize.md,
    lineHeight: 22,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  link: {
    color: Colors.sage[700],
    fontSize: Typography.fontSize.md,
    textAlign: "center",
    fontFamily: Typography.face.sans[500],
  },
});
