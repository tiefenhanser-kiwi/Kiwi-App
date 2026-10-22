// WS7-8b Block 4 (Block 1) — shared cook/prep footer nav.
//
// Lifted VERBATIM from CookSessionView: a back button + the primary advance CTA,
// with a dimmed "Next · {label}" preview and a "~N min left" line above. The
// advance/back labels are props (defaulting to the Cook screen's exact copy) so
// the Week Prep screen can relabel without forking the layout; with the defaults
// the Cook screen renders byte-for-byte as before.
//
// BUG-020 (Hans-ruled footer redesign): an OPTIONAL `secondaryActions` row of
// text/secondary buttons renders ABOVE the back+primary row so Week Prep can
// carry three actions (primary "Mark all complete" + "Skip this Prep" +
// "Save & Exit") without a bespoke layout. Back-compat is load-bearing:
// CookSessionView passes nothing → the row is absent → Cook Mode renders exactly
// as before (same discipline as ProgressSegments.partialIndices).
//
// Oct 3 — an OPTIONAL `statusLine` replaces the "Next · …" / "~N min left" pair
// with one caller-composed line (Week Prep: "Next: X · This step: ~N min").
// Same back-compat rule: Cook Mode passes nothing and renders as before — the
// e2e harness reads its "~N min left" (e2e/src/screen.ts).

//
// PREP-2 item 5 — an OPTIONAL `compact`: the large-text shape (Prep the Week only,
// lib/cooking/prepWeekLayout.ts). ONE row — back, the primary, and "More", which
// opens the secondary actions as a dialog — with no status line (the screen puts
// it in its scroll) and labels capped at PREP_FOOTER_MAX_FONT_SCALE so the row
// stays one row. Omitted → every byte as before; Cook Mode never passes it.

import React from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { Button } from "@/components/Button";
import { Colors, Palette, Spacing, Typography } from "@/constants/tokens";
import { webFullBleed } from "@/lib/webLayout";
import { PREP_FOOTER_MAX_FONT_SCALE } from "@/lib/cooking/prepWeekLayout";
import { dialog } from "@/lib/dialog";

export interface CookFooterSecondaryAction {
  label: string;
  onPress: () => void;
}

export function CookFooter({
  nextLabel = null,
  remainingMins = 0,
  afterServing,
  statusLine,
  backDisabled,
  showAdvance,
  onPrevStep,
  onAdvance,
  advanceLabel = "Done — next step",
  backLabel = "←",
  secondaryActions,
  compact,
}: {
  nextLabel?: string | null;
  remainingMins?: number;
  /** WEB-4d — the current step starts at serve or later (the feast's dessert):
   *  "After serving" takes the "~N min left" slot. Omit → as before. */
  afterServing?: boolean;
  /** One composed line in place of the Next/min-left pair. Omit (Cook Mode)
   *  → the pair renders exactly as before. */
  statusLine?: string;
  backDisabled: boolean;
  showAdvance: boolean;
  onPrevStep: () => void;
  onAdvance: () => void;
  advanceLabel?: string;
  backLabel?: string;
  /** Secondary/text actions rendered as a row above the back+primary row.
   *  Omit (Cook Mode) → no row, layout unchanged. */
  secondaryActions?: readonly CookFooterSecondaryAction[];
  /** PREP-2 — the large-text shape: one row, the secondary actions behind "More". */
  compact?: boolean;
}) {
  // WEB-4c (BUG-471) — on the web the bar's background spans the window.
  const { width: windowWidth } = useWindowDimensions();
  const footerStyle = webFullBleed(s.footer, windowWidth);
  if (compact) {
    const more = secondaryActions ?? [];
    const openMore = () =>
      dialog.alert("More", undefined, [
        ...more.map((a) => ({ text: a.label, onPress: a.onPress })),
        { text: "Cancel", style: "cancel" as const },
      ]);
    return (
      <View style={footerStyle}>
        <View style={s.compactRow}>
          <View style={s.footerBack}>
            <Button
              label={backLabel}
              variant="secondary"
              disabled={backDisabled}
              onPress={onPrevStep}
              fullWidth={false}
              maxFontSizeMultiplier={PREP_FOOTER_MAX_FONT_SCALE}
            />
          </View>
          {showAdvance && (
            <View style={s.footerNext}>
              <Button
                label={advanceLabel}
                variant="primary"
                onPress={onAdvance}
                maxFontSizeMultiplier={PREP_FOOTER_MAX_FONT_SCALE}
              />
            </View>
          )}
          {more.length > 0 && (
            <Button
              label="More"
              accessibilityLabel={`More: ${more.map((a) => a.label).join(", ")}`}
              variant="secondary"
              fullWidth={false}
              onPress={openMore}
              maxFontSizeMultiplier={PREP_FOOTER_MAX_FONT_SCALE}
            />
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={footerStyle}>
      {statusLine !== undefined ? (
        <Text style={s.nextPreview}>{statusLine}</Text>
      ) : (
        <>
          {nextLabel && <Text style={s.nextPreview}>Next · {nextLabel}</Text>}
          {afterServing ? (
            <Text style={s.remaining}>After serving</Text>
          ) : remainingMins > 0 ? (
            <Text style={s.remaining}>~{remainingMins} min left</Text>
          ) : null}
        </>
      )}
      {secondaryActions && secondaryActions.length > 0 && (
        <View style={s.secondaryRow}>
          {secondaryActions.map((a) => (
            <View key={a.label} style={s.secondaryItem}>
              <Button label={a.label} variant="secondary" onPress={a.onPress} />
            </View>
          ))}
        </View>
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
  // ⚠️ WS9 BUG-199 — MOVED to neutral[700]. This carried a BUG-157 STAY comment
  // reading "STAYS at neutral[600] … sits beside nextPreview, which the ruling
  // names as staying". THE SEPT 2 DEVICE PASS REVERSED THAT: Cook Mode leaves
  // the quiet tier entirely. The pairing argument still holds and now points the
  // other way — nextPreview moved, so this moves with it or the footer splits
  // into two greys. 3.4886:1 -> 5.8956:1 on the footer's neutral[100].
  remaining: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  footerRow: { flexDirection: "row", gap: Spacing[2], marginTop: Spacing[1] },
  // PREP-2 — the large-text row: the same gap, centred so a taller primary
  // (a wrapped label) does not leave the side buttons hanging at the top.
  compactRow: { flexDirection: "row", gap: Spacing[2], alignItems: "center" },
  footerBack: { width: 64 },
  footerNext: { flex: 1 },
  // BUG-020 — secondary/text action row above the primary row (Week Prep only).
  secondaryRow: { flexDirection: "row", gap: Spacing[2], marginTop: Spacing[1] },
  secondaryItem: { flex: 1 },
});
