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

  const remove = (item: string) => {
    onChange(value.filter((i) => i !== item));
  };

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
      {value.length > 0 && (
        <View style={s.list}>
          {value.map((item) => (
            <View key={item} style={s.row}>
              <Text style={s.rowText}>{item}</Text>
              <Pressable
                onPress={() => remove(item)}
                hitSlop={8}
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <Feather name="x" size={16} color={Colors.neutral[600]} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

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
          placeholderTextColor={Colors.neutral[600]}
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
  list: {
    gap: Spacing[1],
    marginBottom: Spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[3],
    backgroundColor: Colors.neutral[100],
    borderRadius: Radius.md,
  },
  rowText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  subLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
    marginTop: Spacing[4],
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
