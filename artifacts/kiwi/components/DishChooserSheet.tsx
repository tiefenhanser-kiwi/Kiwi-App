import React, { useMemo, useState } from "react";
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
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { sortDishes } from "@/components/dishSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getSavedDishes } from "@/lib/stubs";
import type { SavedDish } from "@/lib/types";

export interface DishChooserSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Called when user picks a saved dish OR adds a Simple Dish. */
  onPickSavedDish: (dish: SavedDish) => void;
  /** Optional override for "Ask Kiwi" submission. WS5 default fires a
   *  "Coming in WS6" alert. Kept for future composition. */
  onAskKiwi?: (prompt: string) => void;
}

export function DishChooserSheet({
  visible,
  onClose,
  onPickSavedDish,
  onAskKiwi,
}: DishChooserSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [askPrompt, setAskPrompt] = useState("");
  // PRD: A-Z is the default sort across all sortable surfaces.
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  // Newly-added Simple Dishes — held inside the sheet so the parent
  // (Meal Builder) doesn't need to know. Resets on each visible cycle
  // because the component unmounts on Modal hide; WS7 will persist
  // these to the real saved-dishes store.
  const [addedSimpleDishes, setAddedSimpleDishes] = useState<SavedDish[]>([]);

  // Add Simple Dish inline form
  const [simpleDishExpanded, setSimpleDishExpanded] = useState(false);
  const [simpleDishName, setSimpleDishName] = useState("");

  const allDishes = useMemo(
    () => sortDishes([...addedSimpleDishes, ...getSavedDishes()], sortKey),
    [addedSimpleDishes, sortKey],
  );

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

  const handleAddSimpleDish = () => {
    Keyboard.dismiss();
    const trimmedName = simpleDishName.trim();
    if (!trimmedName) return;
    const newDish: SavedDish = {
      id: `simple-dish-${Date.now()}`,
      name: trimmedName,
      ingredients: [{ quantity: 1, unit: "whole", name: trimmedName }],
      caloriesPerServing: 0,
      proteinGPerServing: 0,
      carbsGPerServing: 0,
      fatGPerServing: 0,
      useCount: 0,
      createdAt: new Date().toISOString(),
    };
    setAddedSimpleDishes((prev) => [newDish, ...prev]);
    onPickSavedDish(newDish);
    setSimpleDishName("");
    setSimpleDishExpanded(false);
    onClose();
  };

  const handleCancelSimpleDish = () => {
    Keyboard.dismiss();
    setSimpleDishName("");
    setSimpleDishExpanded(false);
  };

  const handleHaveInMind = () => {
    Keyboard.dismiss();
    onClose();
    // Match the Import URL/Image card pattern: defer push slightly so the
    // sheet finishes its slide-out before the new screen mounts.
    setTimeout(() => {
      router.push("/dish-builder");
    }, 150);
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
            {/* Section 1: My Dishes (sortable) */}
            <View style={s.sectionTitleRow}>
              <Text style={s.sectionTitle}>My Dishes</Text>
              <SortDropdown value={sortKey} onChange={setSortKey} />
            </View>
            <View style={{ gap: KSpacing.sm, marginTop: KSpacing.sm }}>
              {allDishes.map((dish) => (
                <Pressable
                  key={dish.id}
                  onPress={() => handlePickSaved(dish)}
                  style={({ pressed }) => [
                    s.dishRow,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View
                    style={[s.thumb, !dish.imageUrl && s.thumbFallback]}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={s.dishName}>{dish.name}</Text>
                    <Text style={s.dishMeta}>
                      {[
                        dish.cuisineType,
                        `${dish.caloriesPerServing} cal/serving`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  {dish.useCount !== undefined && (
                    <Text style={s.useCount}>
                      Used in {dish.useCount} meals
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>

            {/* Section 2: Ask Kiwi (locked / premium) */}
            <View style={[s.askSection, { marginTop: KSpacing.lg }]}>
              <View style={s.askHeader}>
                <Text style={s.sectionTitle}>Ask Kiwi</Text>
                <View style={s.premiumPill}>
                  <Feather
                    name="lock"
                    size={10}
                    color={KColors.terracotta[700]}
                  />
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

            {/* Section 3: Add Simple Dish (inline expandable) */}
            {!simpleDishExpanded ? (
              <Pressable
                onPress={() => setSimpleDishExpanded(true)}
                style={({ pressed }) => [
                  s.simpleDishCollapsed,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.sectionTitle}>Add Simple Dish</Text>
                  <Text style={s.sectionSubtitle}>
                    Store-bought sides, simple plating, leftovers
                  </Text>
                </View>
                <Feather name="plus" size={18} color={KColors.sage[700]} />
              </Pressable>
            ) : (
              <View style={s.simpleDishExpanded}>
                <Text style={s.sectionTitle}>Add Simple Dish</Text>
                <Text style={s.sectionSubtitle}>
                  Store-bought sides, simple plating, leftovers
                </Text>
                <TextInput
                  value={simpleDishName}
                  onChangeText={setSimpleDishName}
                  placeholder="What is it? (e.g., Bag of Lay's Classic Chips, Leftover pizza, Trader Joe's gnocchi)"
                  placeholderTextColor={KColors.neutral[600]}
                  style={s.simpleDishInput}
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={handleAddSimpleDish}
                  autoFocus
                />
                <View style={s.simpleDishActionsRow}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Add"
                      variant="primary"
                      disabled={simpleDishName.trim().length === 0}
                      onPress={handleAddSimpleDish}
                    />
                  </View>
                  <Pressable
                    onPress={handleCancelSimpleDish}
                    hitSlop={6}
                    style={({ pressed }) => [
                      s.cancelLink,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text style={s.cancelLinkText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Section 4: Have something in mind? (stub) */}
            <Pressable
              onPress={handleHaveInMind}
              style={({ pressed }) => [
                s.haveInMindLink,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={s.haveInMindTitle}>
                Have something in mind? Add it to your saved Dishes.
              </Text>
              <Text style={s.haveInMindSubtitle}>
                Build a custom dish with ingredients, steps, and macros.
              </Text>
            </Pressable>
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
    // Anchor the sheet at ~85% of screen so the picker isn't a tiny
    // strip when content is short. Keyboard avoidance still pushes
    // the keyboard-relevant content up via KeyboardAvoidingView.
    height: "85%",
  },
  sheet: {
    flex: 1,
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
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
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
  simpleDishCollapsed: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    marginTop: KSpacing.lg,
  },
  simpleDishExpanded: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
  },
  simpleDishInput: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.sm,
  },
  simpleDishActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    marginTop: KSpacing.xs,
  },
  cancelLink: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.sm,
  },
  cancelLinkText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  haveInMindLink: {
    marginTop: KSpacing.lg,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
  },
  haveInMindTitle: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  haveInMindSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    textAlign: "center",
  },
});
