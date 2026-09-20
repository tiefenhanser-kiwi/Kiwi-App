import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { InstacartButton } from "@/components/InstacartButton";
import { Colors, Spacing, Typography } from "@/constants/tokens";
import {
  INSTACART_COMING_SOON_COPY,
  INSTACART_EXPECTATION_COPY,
} from "@/lib/instacartOrder";

// Row 8 Block 2 — the flag-gated order block in the grocery detail screen's
// in-scroll action area, beside "Mark Shopping Done ✓".
//
// Extracted from app/grocery-list/[id].tsx for the same reason ClarifySheetView
// was (WS7-8b Block C): app/** is outside the test glob (D-WS9-164), and the
// gate — flag true → the CTA; flag false → a quiet, non-interactive line and
// NO button — is one of the things this block must pin.
//
// The flag is the SERVER's (`retailers.instacart.enabled` on the detail GET),
// so approval flips a row instead of forcing an App Store resubmission. The
// off state is D-WS9-099's stub condition, modified: a dead affordance is
// removed, not restyled, so there is no disabled button here — just the line.
//
// Under the CTA, one line sets the measured expectation (September 19 device
// pass: the same URL rendered 11, then 48, then 34 items as matching filled
// in; quantity is advisory). The error line, when there is one, is already
// Kiwi's copy (instacartErrorCopy) — never a raw server string.

interface Props {
  enabled: boolean;
  busy: boolean;
  error: string | null;
  onPress: () => void;
}

export function InstacartOrderPanel({ enabled, busy, error, onPress }: Props) {
  if (!enabled) {
    return (
      <View style={s.wrap} testID="instacart-coming-soon">
        <Text style={s.quiet}>{INSTACART_COMING_SOON_COPY}</Text>
      </View>
    );
  }
  return (
    <View style={s.wrap}>
      <InstacartButton onPress={onPress} loading={busy} testID="instacart-cta" />
      <Text style={s.quiet}>{INSTACART_EXPECTATION_COPY}</Text>
      {error ? (
        <Text style={s.error} testID="instacart-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    gap: Spacing[2],
  },
  quiet: {
    fontFamily: Typography.face.sans[400],
    fontSize: 13,
    lineHeight: 18,
    color: Colors.neutral[600],
  },
  error: {
    fontFamily: Typography.face.sans[500],
    fontSize: 13,
    lineHeight: 18,
    color: Colors.terracotta[700],
  },
});
