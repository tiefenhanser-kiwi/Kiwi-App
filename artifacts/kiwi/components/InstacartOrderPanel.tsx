import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { InstacartButton } from "@/components/InstacartButton";
import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  INSTACART_EXPECTATION_COPY,
  instacartCountSummary,
  stapleDisplayName,
} from "@/lib/instacartOrder";
import type { GroceryListItem } from "@/lib/types";

// Row 8 Block 2 — the flag-gated order block on the grocery detail screen.
// Block 3 Part A moved it to the top of the scroll; Part D added the count
// line under the CTA and the staples disclosure.
//
// Extracted from app/grocery-list/[id].tsx for the same reason ClarifySheetView
// was (WS7-8b Block C): app/** is outside the test glob (D-WS9-164), and the
// gate — flag true → the CTA; flag false → a quiet, non-interactive line and
// NO button — is one of the things this block must pin.
//
// The flag is the SERVER's (`retailers.instacart.enabled` on the detail GET),
// so approval flips a row instead of forcing an App Store resubmission.
//
// ⚠️ THE OFF STATE RENDERS NOTHING AT ALL (Hans, September 22). Block 2 shipped
// a quiet non-interactive line — "Online grocery ordering is coming soon." —
// on his own September 13 ask for a friendly stub. He WITHDREW that ask for the
// store build: with the flag off, nothing Instacart-shaped renders anywhere, on
// this screen or on Plan Review. The reasoning is D-WS9-099's, applied one step
// further than Block 2 applied it: a dead affordance is removed, not restyled,
// and a LINE promising a feature is the same work-in-progress signal a disabled
// button is. The list is already reachable through the plan's "Grocery List"
// button and the Home card. When Instacart approves, the flag flips and both
// the CTA here and the cell on Plan Review appear with NO app update — which is
// exactly Block 2's design, unchanged.
//
// ── The count line (Part D, Hans-ruled September 21) ─────────────────────
// "Sends 54 items · 6 pantry staples not included", computed by
// instacartCountSummary from the SAME R1 selection the tap sends, off the
// same `items` the screen holds — so it moves as rows are checked or a staple
// is opted in. The "N items" half is plain text. Only the staples fragment is
// a control: it toggles an inline disclosure of those rows by name, each with
// an Add that opts it in through the screen's own handler (onAddStaple — the
// row's "+" path, not a second mutation). Names only: BUG-171 rules a staple
// shows no pack, so nothing here composes one. The disclosure is collapsed on
// every mount — a check, not a preference — and closes itself when the last
// staple is added, since the fragment it hangs off is gone too.
//
// Disclosure idiom: text + Feather chevron-up/down (14, sage[700]) as
// preference-pickers/shared.tsx ExpandLink draws it, with the role +
// expanded state SwapMealSheet's import expander carries. ExpandLink itself
// is not reused: its label is a standalone line, and this trigger is a
// fragment inside a sentence that must sit inline after "Sends N items · ".
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
  /** The list's rows — the same array the tap selects from. */
  items: GroceryListItem[];
  /** Opt a held-back staple in (the row's own "+" handler, lifted). */
  onAddStaple: (item: GroceryListItem) => void;
}

export function InstacartOrderPanel({
  enabled,
  busy,
  error,
  onPress,
  items,
  onAddStaple,
}: Props) {
  // Hooks above the early return.
  const [staplesOpen, setStaplesOpen] = useState(false);
  const summary = instacartCountSummary(items);
  const heldBackCount = summary.heldBack.length;
  useEffect(() => {
    if (heldBackCount === 0) setStaplesOpen(false);
  }, [heldBackCount]);

  if (!enabled) return null;
  const showStaples = staplesOpen && heldBackCount > 0;
  return (
    <View style={s.wrap}>
      <InstacartButton onPress={onPress} loading={busy} testID="instacart-cta" />
      <View style={s.countRow} testID="instacart-count">
        <Text style={s.count}>{summary.sendsText}</Text>
        {summary.staplesText ? (
          <>
            <Text style={s.count}> · </Text>
            <Pressable
              onPress={() => setStaplesOpen((o) => !o)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityState={{ expanded: showStaples }}
              accessibilityLabel={`${showStaples ? "Hide" : "Show"} the ${summary.staplesText}`}
              style={({ pressed }) => [s.staplesToggle, pressed && { opacity: 0.6 }]}
              testID="instacart-staples-toggle"
            >
              <Text style={s.staplesToggleText}>{summary.staplesText}</Text>
              <Feather
                name={showStaples ? "chevron-up" : "chevron-down"}
                size={14}
                color={Colors.sage[700]}
              />
            </Pressable>
          </>
        ) : null}
      </View>
      {showStaples ? (
        <View style={s.staplesList} testID="instacart-staples">
          {summary.heldBack.map((item) => {
            const name = stapleDisplayName(item);
            return (
              <View key={item.id} style={s.stapleRow}>
                <Text style={s.stapleName} numberOfLines={2}>
                  {name}
                </Text>
                <Pressable
                  onPress={() => onAddStaple(item)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${name}`}
                  style={({ pressed }) => [s.stapleAdd, pressed && { opacity: 0.6 }]}
                  testID={`instacart-staple-add-${item.id}`}
                >
                  <Feather name="plus" size={12} color={Colors.sage[700]} />
                  <Text style={s.stapleAddText}>Add</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
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
  countRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  count: {
    fontFamily: Typography.face.sans[500],
    fontSize: 13,
    lineHeight: 18,
    color: Colors.neutral[700],
  },
  staplesToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  staplesToggleText: {
    fontFamily: Typography.face.sans[600],
    fontSize: 13,
    lineHeight: 18,
    color: Colors.sage[700],
  },
  staplesList: {
    backgroundColor: Colors.neutral[0],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[200],
    paddingHorizontal: Spacing[3],
  },
  stapleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[3],
    paddingVertical: Spacing[2],
  },
  stapleName: {
    flex: 1,
    fontFamily: Typography.face.sans[400],
    fontSize: 14,
    lineHeight: 20,
    color: Colors.neutral[800],
  },
  stapleAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: Spacing[2],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.sage[300],
  },
  stapleAddText: {
    fontFamily: Typography.face.sans[600],
    fontSize: 13,
    lineHeight: 16,
    color: Colors.sage[700],
  },
});
