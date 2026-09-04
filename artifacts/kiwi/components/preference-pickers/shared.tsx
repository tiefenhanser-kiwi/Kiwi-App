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
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export const pickerStyles = StyleSheet.create({
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  expandLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: Spacing[2],
    alignSelf: "flex-start",
  },
  expandLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  // WS9 D-WS9-206 — moved here from RecurringItemsPicker's local StyleSheet
  // with CustomChipInput. Values are byte-identical to what that picker had,
  // so nothing moves on the two screens that already render it.
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

export function ExpandLink({
  expanded,
  label,
  onPress,
}: {
  expanded: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [pickerStyles.expandLink, pressed && { opacity: 0.6 }]}
    >
      <Text style={pickerStyles.expandLinkText}>{label}</Text>
      <Feather
        name={expanded ? "chevron-up" : "chevron-down"}
        size={14}
        color={Colors.sage[700]}
      />
    </Pressable>
  );
}

export function toggleInArray<T>(arr: readonly T[], item: T): T[] {
  return arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item];
}

// ── WS9 D-WS9-206 — CustomChipInput ────────────────────────────────────────
// A chip row over an add-a-term input. EXTRACTED, not net-new: this is
// RecurringItemsPicker's entire body below its sub-label, lifted verbatim
// (chip row -> add row -> plus button, same styles, same handlers).
//
// §27.2, and the reason this is an extraction rather than a second copy: the
// new "other allergies" field needs exactly this control, and the alternative
// was pasting ~35 lines of TextInput + plus-button + chip-row into
// DietarySection. RecurringItemsPicker now consumes this, so there is one
// add-a-term control in the app, not two.
//
// ⚠️ `recurringChipRow` (lib/domain.ts) is NOT reused and does not generalize.
// Its whole mechanism is "merge a FIXED common list with the custom entries,
// de-duplicated" — and other-allergies has no common list (the 11 canonical
// labels are already the AllergiesPicker chips above it). Applied there it
// degenerates to `[...[], ...value]` === `value`, i.e. the helper contributes
// nothing. So the caller passes `chips` in: RecurringItemsPicker passes
// recurringChipRow(value); the allergies field passes value itself.
export function CustomChipInput({
  chips,
  value,
  onToggle,
  onAdd,
  placeholder,
  placeholderTextColor = Palette.text.placeholder,
  addAccessibilityLabel,
}: {
  /** Every chip to render, in order. */
  chips: readonly string[];
  /** The selected set (drives each chip's `selected` state). */
  value: readonly string[];
  onToggle: (item: string) => void;
  onAdd: (item: string) => void;
  placeholder: string;
  /** ⚠️ Defaults to the app token so RecurringItemsPicker is pixel-identical
   *  to what it rendered before this extraction. The dietary section passes
   *  neutral[700] — see the note at the call site. */
  placeholderTextColor?: string;
  addAccessibilityLabel: string;
}) {
  const [draft, setDraft] = useState("");

  const handleAddDraft = () => {
    const trimmed = draft.trim();
    if (trimmed) onAdd(trimmed);
    setDraft("");
    Keyboard.dismiss();
  };

  return (
    <View>
      {chips.length > 0 && (
        <View style={pickerStyles.chipRow}>
          {chips.map((item) => (
            <Chip
              key={item}
              label={item}
              selected={value.includes(item)}
              onPress={() => onToggle(item)}
            />
          ))}
        </View>
      )}

      <View style={pickerStyles.addRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={placeholderTextColor}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={handleAddDraft}
          style={pickerStyles.input}
        />
        <Pressable
          onPress={handleAddDraft}
          disabled={!draft.trim()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={addAccessibilityLabel}
          style={({ pressed }) => [
            pickerStyles.addBtn,
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
