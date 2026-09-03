import React, { useState } from "react";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { Chip } from "@/components/Chip";
import { recurringChipRow } from "@/lib/domain";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

import { pickerStyles } from "./shared";

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
  const [draft, setDraft] = useState("");

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
    const trimmed = item.trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) return;
    onChange([...value, trimmed]);
  };

  const handleAddDraft = () => {
    add(draft);
    setDraft("");
    Keyboard.dismiss();
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
      {/* WS9 BUG-152 — the chip row now carries the user's CUSTOM items too, not
          just the eight common ones. Adding "lime" persisted fine and showed
          nothing back: the new entry rendered as a row at the TOP of the
          section while the user was looking at the input at the BOTTOM, and the
          only other confirmation was an 800ms-debounced toast. This row sits
          directly above the input, so the added chip lands where the tap did.
          Composition is a pure, tested helper (recurringChipRow). */}
      <View style={pickerStyles.chipRow}>
        {recurringChipRow(value).map((item) => (
          <Chip
            key={item}
            label={item}
            selected={value.includes(item)}
            onPress={() => toggle(item)}
          />
        ))}
      </View>

      <View style={s.addRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add custom item..."
          placeholderTextColor={Palette.text.placeholder}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={handleAddDraft}
          style={s.input}
        />
        <Pressable
          onPress={handleAddDraft}
          disabled={!draft.trim()}
          hitSlop={8}
          style={({ pressed }) => [
            s.addBtn,
            !draft.trim() && { opacity: 0.4 },
            pressed && draft.trim() && { opacity: 0.7 },
          ]}
        >
          <Feather name="plus" size={20} color={Colors.neutral[0]} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // WS9 (Sept 3) — `list`, `row` and `rowText` are DELETED with the duplicate
  // list they styled.
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
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    marginTop: Spacing[3],
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
});
