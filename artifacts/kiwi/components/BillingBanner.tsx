// Row 9 (1.1) · Stripe S2 Part E — the Home banner (§2.4).
//
// ONE banner at a time, and that is structural rather than enforced here: the
// status is a single value, so `bannerFor` is a mapping and there is no priority
// list to get wrong. This component renders whatever it returns, or nothing.
//
// 🔴 IT RENDERS NOTHING WHILE `enforced` IS FALSE, which is the state 1.1 ships
// in — and the check is NOT in this file. `bannerFor` blacks it out
// (lib/billing/subscriptionView.ts), so the blackout is proved by a pure test over
// every status rather than by reading JSX. Deliberate break (1) in the S2 report
// removes that line and the banner appears in an unenforced build.
//
// Shaped after GetTheAppStrip: a slim full-width strip above the header content,
// which is the app's existing answer to "a persistent line at the top of Home".
// The sage palette for the two offers; terracotta for `past_due`, because a failed
// payment is the one of the three that is a problem rather than an invitation.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import { useBilling } from "@/contexts/BillingContext";

export function BillingBanner() {
  const { banner, dismissCurrentBanner, openSheet, openPortal } = useBilling();
  if (banner === null) return null;

  const isProblem = banner.kind === "past_due";

  // `past_due` goes to the Portal (the card is what needs fixing); the other two
  // open the sheet (a decision is what is being asked for).
  const onPress = () => {
    if (isProblem) {
      void openPortal();
    } else {
      openSheet();
    }
  };

  return (
    <View
      style={[s.strip, isProblem ? s.stripProblem : s.stripOffer]}
      testID={`billing-banner-${banner.kind}`}
    >
      <Feather
        name={isProblem ? "alert-circle" : "gift"}
        size={16}
        color={isProblem ? Colors.terracotta[600] : Colors.sage[700]}
      />
      <Text style={s.line} numberOfLines={3}>
        {banner.text}
      </Text>
      <Pressable
        onPress={onPress}
        hitSlop={8}
        style={({ pressed }) => [s.cta, pressed && { opacity: 0.7 }]}
        testID={`billing-banner-cta-${banner.kind}`}
      >
        <Text style={[s.ctaText, isProblem && s.ctaTextProblem]}>{banner.ctaLabel}</Text>
      </Pressable>
      {/* Only the dismissible ones get an X. `past_due` has none — see
          BannerView.dismissible, and dismissals.ts, which also refuses to write
          it even if a caller reached here with it. */}
      {banner.dismissible && (
        <Pressable
          onPress={dismissCurrentBanner}
          hitSlop={10}
          accessibilityLabel="Dismiss"
          testID={`billing-banner-dismiss-${banner.kind}`}
        >
          <Feather name="x" size={16} color={Colors.neutral[600]} />
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    borderBottomWidth: 1,
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[2],
  },
  stripOffer: {
    backgroundColor: Colors.sage[50],
    borderBottomColor: Colors.sage[300],
  },
  stripProblem: {
    backgroundColor: Colors.terracotta[50],
    borderBottomColor: Colors.terracotta[300],
  },
  line: {
    flex: 1,
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 16,
  },
  cta: {
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
    borderRadius: Radius.sm,
  },
  ctaText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
  },
  ctaTextProblem: {
    color: Colors.terracotta[600],
  },
});
