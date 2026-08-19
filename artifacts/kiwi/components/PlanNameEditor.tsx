import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { DisplayTitle } from "@/components/DisplayTitle";

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
          placeholderTextColor={Colors.neutral[600]}
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
      {/* WS9-2 2e Part 4 Item 1 — `slim` → `hero`. This is a LINE-POLICY change
          and nothing else: slim caps at one line and ellipsizes, hero is
          uncapped and wraps (DisplayTitle VARIANT_LINES). It mirrors the
          meal/dish detail heroes, which were confirmed uncapped rather than
          two-line-capped.

          ⚠️ NO TYPE CHANGE. DisplayTitle deliberately does not own typography —
          size, weight and face stay with s.name below, exactly as they were. So
          the visible difference is a long name WRAPPING where it used to
          truncate, not a jump in type size.

          The editor now sits on its own full-width row (app/plan/[id].tsx Item
          1), so a wrapped name has the width to be worth wrapping into. */}
      <DisplayTitle source={currentName} variant="hero" style={s.name} />
      <Feather name="edit-2" size={14} color={Colors.sage[700]} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  name: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    flexShrink: 1,
  },
  editingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  input: {
    flex: 1,
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing[2],
    paddingVertical: 6,
  },
});
