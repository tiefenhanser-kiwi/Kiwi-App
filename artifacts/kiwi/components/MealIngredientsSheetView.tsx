// WS9 D-WS9-058 (BUG-331) — the meal's consolidated ingredient list, as a
// sheet. Presentational and data-injected: the caller consolidates (lib/meals/
// consolidateMealIngredients) and owns visibility; this renders and forwards
// the close tap.
//
// Extracted from the screen for the usual reason (app/** is outside the test
// glob, D-WS9-164) and shaped like ClarifySheetView / DishChooserSheetView —
// backdrop Pressable, bottom sheet capped at 90%, a flexShrink'd ScrollView so
// a long list actually scrolls. There is no shared Sheet primitive in this
// codebase (12 sheets, each with its own Modal); this does not introduce one.
//
// ⚠️ DISPLAY-ONLY, per the ruling. Nothing here writes, and there is no edit
// affordance — the ingredient list is authored by the recipe and the servings
// stepper on the screen behind is the only thing that changes it.

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { ConsolidatedIngredient } from "@/lib/meals/consolidateMealIngredients";

export interface MealIngredientsSheetViewProps {
  visible: boolean;
  /** The meal's name, for the sheet header. */
  title: string;
  /** The servings the list is scaled to — the DISPLAYED count, not the base. */
  servings: number;
  /** Already consolidated and already scaled. */
  items: ConsolidatedIngredient[];
  /** True when the meal has more than one dish, which is when provenance earns
   *  its line — on a single-dish meal every row would say the same thing. */
  showProvenance: boolean;
  onClose: () => void;
}

export function MealIngredientsSheetView({
  visible,
  title,
  servings,
  items,
  showProvenance,
  onClose,
}: MealIngredientsSheetViewProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} testID="meal-ingredients-backdrop">
        {/* Swallow taps inside the sheet so the backdrop's onPress does not
            close it from under the scroll. */}
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.header}>
            <View style={s.headerText}>
              <Text style={s.heading} numberOfLines={2}>
                {title}
              </Text>
              <Text style={s.subheading}>
                Everything you need · {servings} {servings === 1 ? "serving" : "servings"}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close ingredients"
              testID="meal-ingredients-close"
            >
              <Feather name="x" size={22} color={Colors.neutral[700]} />
            </Pressable>
          </View>

          <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
            {items.length === 0 ? (
              <Text style={s.empty}>This meal has no ingredients listed.</Text>
            ) : (
              items.map((it, i) => (
                <View key={`${it.name}|${it.unit}|${i}`} style={s.row}>
                  <Text style={s.line}>{it.line}</Text>
                  {showProvenance && it.dishTitles.length > 0 && (
                    <Text style={s.provenance}>For {it.dishTitles.join(", ")}</Text>
                  )}
                </View>
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: Palette.background.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Colors.neutral[0],
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    maxHeight: "90%",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: Spacing[3],
    padding: Spacing[4],
    paddingBottom: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  heading: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  subheading: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  // flexShrink lets the ScrollView collapse to the capped sheet height (rather
  // than overflowing it) so a long list becomes scrollable — the same fix
  // BUG-026 made on the clarify sheet.
  scroll: {
    flexShrink: 1,
  },
  scrollContent: {
    padding: Spacing[4],
    paddingBottom: Spacing[4] + 24,
    gap: Spacing[2],
  },
  row: {
    gap: 2,
  },
  line: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  provenance: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  empty: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
