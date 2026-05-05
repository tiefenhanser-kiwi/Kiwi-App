import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

export interface PlanNameEditorProps {
  currentName: string;
  onSave: (newName: string) => void;
}

export function PlanNameEditor({ currentName, onSave }: PlanNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(currentName);

  // Keep draft in sync if upstream name changes while not editing
  // (e.g. plan switch, undo).
  useEffect(() => {
    if (!editing) setDraftName(currentName);
  }, [currentName, editing]);

  const commit = () => {
    const trimmed = draftName.trim();
    if (trimmed.length === 0) {
      setDraftName(currentName);
    } else if (trimmed !== currentName) {
      onSave(trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <View style={s.editingRow}>
        <TextInput
          autoFocus
          value={draftName}
          onChangeText={setDraftName}
          onBlur={commit}
          onSubmitEditing={commit}
          returnKeyType="done"
          blurOnSubmit
          maxLength={60}
          style={s.input}
          placeholder="Plan name"
          placeholderTextColor={KColors.neutral[600]}
        />
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => setEditing(true)}
      style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
      hitSlop={6}
    >
      <Text style={s.name} numberOfLines={1} ellipsizeMode="tail">
        {currentName || "Untitled plan"}
      </Text>
      <Feather name="edit-2" size={14} color={KColors.sage[700]} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  name: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    flexShrink: 1,
  },
  editingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  input: {
    flex: 1,
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    backgroundColor: KColors.neutral[0],
    borderWidth: 1,
    borderColor: KColors.sage[300],
    borderRadius: KRadius.sm,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 6,
  },
});
