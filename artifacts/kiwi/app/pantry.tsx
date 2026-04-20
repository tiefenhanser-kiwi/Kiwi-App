import React, { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

const QUICK_ADD = [
  "Olive oil",
  "Salt",
  "Black pepper",
  "Garlic",
  "Onion",
  "Rice",
  "Pasta",
  "Eggs",
  "Butter",
  "Lemon",
];

export default function PantryScreen() {
  const { pantry, addPantryItem, removePantryItem } = useApp();
  const [text, setText] = useState("");

  const submit = async () => {
    const v = text.trim();
    if (!v) return;
    await addPantryItem(v);
    setText("");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        title="My Pantry"
        subtitle="Kiwi prefers recipes that use what you have"
        showBack
      />
      <Screen>
        <Card padded>
          <Text style={s.label}>Add an item</Text>
          <View style={s.inputRow}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="e.g. Chickpeas"
              placeholderTextColor={KColors.neutral[600]}
              onSubmitEditing={submit}
              returnKeyType="done"
              style={s.input}
            />
            <Pressable
              onPress={submit}
              style={({ pressed }) => [s.addBtn, pressed && { opacity: 0.85 }]}
            >
              <Feather name="plus" size={20} color="#fff" />
            </Pressable>
          </View>

          <Text style={[s.label, { marginTop: KSpacing.md }]}>Quick add</Text>
          <View style={s.quickRow}>
            {QUICK_ADD.filter(
              (q) =>
                !pantry.some((p) => p.toLowerCase() === q.toLowerCase()),
            ).map((q) => (
              <Pressable
                key={q}
                onPress={() => addPantryItem(q)}
                style={({ pressed }) => [
                  s.quickChip,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Feather name="plus" size={12} color={KColors.sage[700]} />
                <Text style={s.quickText}>{q}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Text style={s.sectionTitle}>
          {pantry.length === 0
            ? "Pantry is empty"
            : `${pantry.length} item${pantry.length === 1 ? "" : "s"} in your pantry`}
        </Text>

        {pantry.length === 0 ? (
          <Card padded>
            <Text style={s.empty}>
              Add items here to skip them on grocery lists and let Kiwi prefer
              recipes you can already cook.
            </Text>
          </Card>
        ) : (
          <View style={{ gap: KSpacing.sm }}>
            {pantry.map((name) => (
              <View key={name} style={s.itemRow}>
                <Feather name="check-circle" size={18} color={KColors.sage[700]} />
                <Text style={s.itemText}>{name}</Text>
                <Pressable
                  onPress={() => removePantryItem(name)}
                  hitSlop={10}
                  style={({ pressed }) => [
                    s.removeBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Feather name="x" size={16} color={KColors.neutral[700]} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  label: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: KSpacing.sm,
    fontFamily: "Inter_600SemiBold",
  },
  inputRow: { flexDirection: "row", gap: KSpacing.sm },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[100],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 12,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  addBtn: {
    width: 48,
    height: 48,
    borderRadius: KRadius.md,
    backgroundColor: KColors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
  quickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  quickChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: KColors.sage[50],
    borderRadius: 999,
    borderWidth: 1,
    borderColor: KColors.sage[300],
  },
  quickText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
  },
  sectionTitle: {
    fontSize: KType.size.sm,
    color: KColors.sage[600],
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: KSpacing.xl,
    marginBottom: KSpacing.sm,
    paddingHorizontal: 4,
    fontFamily: "Inter_600SemiBold",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  itemText: {
    flex: 1,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
  },
  removeBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: KColors.neutral[200],
  },
  empty: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
});
