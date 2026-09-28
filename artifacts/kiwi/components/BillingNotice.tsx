// Row 9 (1.1) · Stripe S2 Part E — the lapsed-account notice (§2.6 / D-WS9-272).
//
// Hans's ruling, verbatim: "keep what exists · do not pretend the call ran · say
// why in place · offer the upgrade." This component is the last two clauses; the
// first two are properties of WHERE it is placed, so they are worth naming here
// because a future caller will not read the deferred log:
//
//   KEEP WHAT EXISTS — this notice is rendered BESIDE the content, never instead
//     of it. The stale grocery list, the stored macro figures and the cuisine
//     matches all stay on screen underneath. A notice that replaced them would be
//     hiding the user's own data behind a sales message.
//   DO NOT PRETEND THE CALL RAN — every caller derives its `text` from a SERVER
//     FIELD (`reconcileSkipped` / `aiSkipped` / `macrosSkipped`), never from
//     guessing. A zero macro figure and a stale list look identical whatever the
//     cause, and only the server knows which cause it was.
//
// Three distinct strings, not one parameterised sentence, because Hans owns the
// copy per surface (lib/billing/copy.ts).
//
// 🔴 `text === null` RENDERS NOTHING, which is how every caller expresses "the
// server did not say the gate did this". The notice-selection helpers in
// subscriptionView.ts return exactly that.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import { useBilling } from "@/contexts/BillingContext";
import { NOTICE_CTA } from "@/lib/billing/copy";

export interface BillingNoticeProps {
  /** The copy, from lib/billing/copy.ts. Null renders nothing. */
  text: string | null;
  testID?: string;
}

export function BillingNotice({ text, testID }: BillingNoticeProps) {
  const { openSheet } = useBilling();
  if (text === null) return null;

  return (
    <View style={s.wrap} testID={testID ?? "billing-notice"}>
      <Feather name="lock" size={14} color={Colors.sage[700]} style={s.icon} />
      <Text style={s.text}>{text}</Text>
      <Pressable
        onPress={() => openSheet()}
        hitSlop={8}
        style={({ pressed }) => [s.cta, pressed && { opacity: 0.7 }]}
        testID={`${testID ?? "billing-notice"}-cta`}
      >
        <Text style={s.ctaText}>{NOTICE_CTA}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
    backgroundColor: Colors.sage[50],
    borderWidth: 1,
    borderColor: Colors.sage[300],
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
  },
  icon: { marginTop: 2 },
  text: {
    flex: 1,
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 17,
  },
  cta: { paddingVertical: Spacing[1] },
  ctaText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
  },
});
