import React, { useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getSavedDishes } from "@/lib/stubs";
import type { SavedDish } from "@/lib/types";

export interface DishChooserSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Called when user picks a saved dish. Pass the full SavedDish. */
  onPickSavedDish: (dish: SavedDish) => void;
  /** Called when user wants to add an empty manual dish. */
  onAddManualDish: () => void;
  /** Called when user submits "Tell Kiwi" prompt — for now, fires a
   *  "coming in WS6" alert from the parent. Pass a no-op for WS5;
   *  component itself shows the prompt UI. */
  onAskKiwi?: (prompt: string) => void;
}

export function DishChooserSheet({
  visible,
  onClose,
  onPickSavedDish,
  onAddManualDish,
  onAskKiwi,
}: DishChooserSheetProps) {
  const insets = useSafeAreaInsets();
  const dishes = getSavedDishes();
  const [askPrompt, setAskPrompt] = useState("");

  // Modal renders outside the parent's KeyboardAwareScrollViewCompat tree, so
  // any sheet TextInput needs its own keyboard avoidance + explicit dismissal
  // on close — otherwise the keyboard can persist after the sheet hides.
  const handleClose = () => {
    Keyboard.dismiss();
    onClose();
  };

  const handlePickSaved = (dish: SavedDish) => {
    Keyboard.dismiss();
    onPickSavedDish(dish);
    onClose();
  };

  const handleAskSubmit = () => {
    Keyboard.dismiss();
    const prompt = askPrompt.trim();
    if (!prompt) return;
    if (onAskKiwi) {
      onAskKiwi(prompt);
    } else {
      Alert.alert(
        "Coming in WS6 — AI orchestration",
        "Kiwi will draft a dish from your description when AI orchestration ships.",
      );
    }
    setAskPrompt("");
  };

  const handleAddManual = () => {
    Keyboard.dismiss();
    onAddManualDish();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <Pressable style={s.backdrop} onPress={handleClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={s.kbAvoidWrap}
        pointerEvents="box-none"
      >
        <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
          <View style={s.handle} />
          <View style={s.header}>
            <Text style={s.title}>Add a dish</Text>
            <Pressable onPress={handleClose} hitSlop={12}>
              <Feather name="x" size={22} color={KColors.neutral[800]} />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
          {/* Section 1: Search my dishes */}
          <Text style={s.sectionTitle}>Search my dishes</Text>
          <Text style={s.sectionSubtitle}>
            Pull a dish from your saved library
          </Text>
          <View style={{ gap: KSpacing.sm, marginTop: KSpacing.sm }}>
            {dishes.map((dish) => (
              <Pressable
                key={dish.id}
                onPress={() => handlePickSaved(dish)}
                style={({ pressed }) => [s.dishRow, pressed && { opacity: 0.7 }]}
              >
                <View
                  style={[s.thumb, !dish.imageUrl && s.thumbFallback]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.dishName}>{dish.name}</Text>
                  <Text style={s.dishMeta}>
                    {[dish.cuisineType, `${dish.caloriesPerServing} cal/serving`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                {dish.useCount !== undefined && (
                  <Text style={s.useCount}>Used in {dish.useCount} meals</Text>
                )}
              </Pressable>
            ))}
          </View>

          {/* Section 2: Ask Kiwi (locked / premium) */}
          <View style={[s.askSection, { marginTop: KSpacing.lg }]}>
            <View style={s.askHeader}>
              <Text style={s.sectionTitle}>Ask Kiwi</Text>
              <View style={s.premiumPill}>
                <Feather name="lock" size={10} color={KColors.terracotta[700]} />
                <Text style={s.premiumPillText}>Premium</Text>
              </View>
            </View>
            <Text style={s.sectionSubtitle}>Coming in WS6</Text>
            <View style={s.askRow}>
              <TextInput
                value={askPrompt}
                onChangeText={setAskPrompt}
                placeholder="Describe what you want — 'roasted broccoli with garlic and lemon' — Kiwi will draft it"
                placeholderTextColor={KColors.neutral[600]}
                style={s.askInput}
                multiline
                returnKeyType="send"
                blurOnSubmit
                onSubmitEditing={handleAskSubmit}
              />
              <Pressable
                onPress={handleAskSubmit}
                disabled={askPrompt.trim().length === 0}
                style={({ pressed }) => [
                  s.askBtn,
                  askPrompt.trim().length === 0 && { opacity: 0.4 },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={s.askBtnText}>Ask Kiwi</Text>
              </Pressable>
            </View>
          </View>

          {/* Section 3: Create manually */}
          <View style={{ marginTop: KSpacing.lg }}>
            <Text style={s.sectionTitle}>Create manually</Text>
            <Text style={s.sectionSubtitle}>Type it in yourself</Text>
            <Pressable
              onPress={handleAddManual}
              style={({ pressed }) => [
                s.addManualBtn,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Feather name="plus" size={16} color={KColors.sage[700]} />
              <Text style={s.addManualBtnText}>Add empty dish</Text>
            </Pressable>
          </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  kbAvoidWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheet: {
    maxHeight: "88%",
    backgroundColor: KColors.neutral[100],
    borderTopLeftRadius: KRadius.xl,
    borderTopRightRadius: KRadius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: KColors.neutral[400],
    alignSelf: "center",
    marginTop: KSpacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
  },
  title: {
    fontSize: KType.size.xl,
    fontWeight: KType.weight.bold,
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
  },
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sectionSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  dishRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  dishName: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dishMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  useCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  askSection: {
    backgroundColor: KColors.neutral[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    opacity: 0.95,
  },
  askHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  askRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
    alignItems: "flex-end",
  },
  askInput: {
    flex: 1,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    minHeight: 60,
    textAlignVertical: "top",
  },
  askBtn: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  askBtnText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  addManualBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingVertical: KSpacing.md,
    marginTop: KSpacing.sm,
  },
  addManualBtnText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
