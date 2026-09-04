import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { recurringChipRow } from "@/lib/domain";
import { Colors, Spacing, Typography } from "@/constants/tokens";

import { CustomChipInput } from "./shared";

export interface RecurringItemsPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Optional sub-heading above the common-items chips. */
  commonItemsLabel?: string;
}

export function RecurringItemsPicker({
  value,
  onChange,
  commonItemsLabel = "Common items",
}: RecurringItemsPickerProps) {
  // WS9 (Sept 3) — `remove` is DELETED with the duplicate list. Its only caller
  // was that list's X button, and `toggle` below already performs the identical
  // onChange for an item that is currently selected. Left in place it would
  // have been dead code that looks like a second removal path.
  const toggle = (item: string) => {
    onChange(
      value.includes(item) ? value.filter((i) => i !== item) : [...value, item],
    );
  };

  const add = (item: string) => {
    if (value.includes(item)) return;
    onChange([...value, item]);
  };

  return (
    <View>
      {/* WS9 (Sept 3) — THE DUPLICATE LIST IS DELETED. This section used to
          render every selected item TWICE: a removable list here at the top,
          and the chip row below. Hans, on device: "we're duplicating the list
          of items and the chips. adding a custom item adds a chip because I was
          confused while testing and didn't see the list above. I actually
          didn't notice it at all until now. I think we can remove the list and
          stick with the chips as the only visual indicators."
          The chips are now the single visual indicator.

          ⚠️ NOTHING WAS STRANDED, and this was checked before deleting. The
          list's only capability was its X button, which called remove(); a
          selected chip calls toggle(), which removes an already-included item
          by the same onChange. And recurringChipRow(value) returns
          [...COMMON_RECURRING_ITEMS, ...customFromValue], so EVERY value —
          common or custom — has a chip. No item can be selected and unreachable.

          This also finishes what BUG-152 started: that fix put custom items in
          the chip row "so the added chip lands where the tap did", but left the
          old list above it, which is precisely the thing Hans could not see. */}
      <Text style={s.subLabel}>{commonItemsLabel}</Text>
      {/* WS9 D-WS9-206 — the chip row + add input are now the shared
          <CustomChipInput> (preference-pickers/shared.tsx), lifted out of this
          file so the new other-allergies field renders the same control rather
          than a second copy of it. The JSX moved verbatim; `toggle` and `add`
          stay here because the VALUE semantics are this picker's, not the
          control's — `add` de-duplicates against `value`, and the chip row is
          recurringChipRow(value) (commons + customs), which no other consumer
          wants.

          BUG-152's guarantee is unchanged: the chip row still sits directly
          above the input, so the added chip lands where the tap did. */}
      <CustomChipInput
        chips={recurringChipRow(value)}
        value={value}
        onToggle={toggle}
        onAdd={add}
        placeholder="Add custom item..."
        addAccessibilityLabel="Add this recurring item"
      />
    </View>
  );
}

const s = StyleSheet.create({
  // WS9 (Sept 3) — `list`, `row` and `rowText` are DELETED with the duplicate
  // list they styled.
  // WS9 D-WS9-206 — `addRow`, `input` and `addBtn` moved to pickerStyles in
  // shared.tsx with CustomChipInput. Values unchanged.
  subLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
    // ⚠️ marginTop DROPPED (was Spacing[4]). It existed to clear the list above,
    // and this is now the FIRST element in the picker — the margin would have
    // become a dead gap under the Section's own subtitle. Both call sites
    // (preferences.tsx, onboarding-prefs.tsx) wrap this in <Section>, which
    // owns the outer spacing, so nothing else needs to move.
    //
    // ⚠️ NOT the optional-style-prop mechanism used when the orphan SubLabel
    // came out of the allergies section last block. That case moved a deleted
    // element's OUTER margin onto the picker; here the deleted element carried
    // no outer margin and the stale spacing is INTERNAL. Reusing that prop
    // would have added an unused API to solve a different problem.
  },
});
