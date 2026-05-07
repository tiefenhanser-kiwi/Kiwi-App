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
import { COMMON_RECURRING_ITEMS } from "@/lib/domain";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

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
                <Feather name="x" size={16} color={KColors.neutral[600]} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Text style={s.subLabel}>{commonItemsLabel}</Text>
      <View style={pickerStyles.chipRow}>
        {COMMON_RECURRING_ITEMS.map((item) => (
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
          placeholderTextColor={KColors.neutral[600]}
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
          <Feather name="plus" size={20} color={KColors.neutral[0]} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  list: {
    gap: KSpacing.xs,
    marginBottom: KSpacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    backgroundColor: KColors.neutral[100],
    borderRadius: KRadius.md,
  },
  rowText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  subLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
    marginTop: KSpacing.lg,
  },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    marginTop: KSpacing.md,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: KRadius.md,
    backgroundColor: KColors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
});
