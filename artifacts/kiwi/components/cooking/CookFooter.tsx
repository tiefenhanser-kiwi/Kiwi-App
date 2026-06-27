// WS7-8b Block 4 (Block 1) — shared cook/prep footer nav.
//
// Lifted VERBATIM from CookSessionView: a back button + the primary advance CTA,
// with a dimmed "Next · {label}" preview and a "~N min left" line above. The
// advance/back labels are props (defaulting to the Cook screen's exact copy) so
// the Week Prep screen can relabel without forking the layout; with the defaults
// the Cook screen renders byte-for-byte as before.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Colors, Palette, Spacing, Typography } from "@/constants/tokens";

export function CookFooter({
  nextLabel,
  remainingMins,
  backDisabled,
  showAdvance,
  onPrevStep,
  onAdvance,
  advanceLabel = "Done — next step",
  backLabel = "←",
}: {
  nextLabel: string | null;
  remainingMins: number;
  backDisabled: boolean;
  showAdvance: boolean;
  onPrevStep: () => void;
  onAdvance: () => void;
  advanceLabel?: string;
  backLabel?: string;
}) {
  return (
    <View style={s.footer}>
      {nextLabel && <Text style={s.nextPreview}>Next · {nextLabel}</Text>}
      {remainingMins > 0 && (
        <Text style={s.remaining}>~{remainingMins} min left</Text>
      )}
      <View style={s.footerRow}>
        <View style={s.footerBack}>
          <Button
            label={backLabel}
            variant="secondary"
            disabled={backDisabled}
            onPress={onPrevStep}
            fullWidth={false}
          />
        </View>
        {showAdvance && (
          <View style={s.footerNext}>
            <Button label={advanceLabel} variant="primary" onPress={onAdvance} />
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  footer: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
    paddingBottom: Spacing[4],
    borderTopWidth: 1,
    borderTopColor: Palette.border.default,
    backgroundColor: Colors.neutral[100],
    gap: Spacing[1],
  },
  nextPreview: {
    fontSize: Typography.fontSize.sm,
    color: Palette.cookMode.nextPreview,
    fontFamily: Typography.face.sans[400],
  },
  remaining: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  footerRow: { flexDirection: "row", gap: Spacing[2], marginTop: Spacing[1] },
  footerBack: { width: 64 },
  footerNext: { flex: 1 },
});
