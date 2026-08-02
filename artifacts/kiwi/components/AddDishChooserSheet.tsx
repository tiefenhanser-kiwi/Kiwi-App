// WS7-6 G3 Scope A — surface #3 (Recipes → Dishes → Add Dish) chooser.
//
// Pre-G3 the "+ Add Dish" button jumped STRAIGHT to the manual Dish Builder,
// skipping any create-mode choice. This sheet restores the chooser, mirroring
// the convention shared with the other Add surfaces: create options listed top
// (Ask-Kiwi FIRST), and — unlike the Meal→Add-Dish reference (#4) — NO
// "pick-existing" list, because adding to your own dish library has no
// pick-an-existing-dish semantics. So #3 is a create-only chooser: Ask Kiwi
// (dish-side Mode A) and Create manually.
//
// Each card closes the sheet then defers the push so the slide-out animation
// finishes before the destination mounts (same pattern as AddMealsSheet).

import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export interface AddDishChooserSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function AddDishChooserSheet({
  visible,
  onClose,
}: AddDishChooserSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const navigateAfterClose = (path: "/ask-kiwi-dish" | "/dish-builder") => {
    onClose();
    setTimeout(() => router.push({ pathname: path }), 150);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Add a dish</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        <View style={s.body}>
          {/* Ask Kiwi first (dish-side Mode A — premium, gated server-side). */}
          <Pressable
            onPress={() => navigateAfterClose("/ask-kiwi-dish")}
            style={({ pressed }) => [s.askCard, pressed && { opacity: 0.85 }]}
            testID="add-dish-ask-kiwi"
          >
            <View style={s.askIcon}>
              <Feather name="zap" size={18} color={Colors.sage[700]} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={s.askTitleRow}>
                <Text style={s.cardTitle}>Ask Kiwi for a dish</Text>
                <View style={s.premiumPill}>
                  <Feather
                    name="lock"
                    size={10}
                    color={Colors.terracotta[700]}
                  />
                  <Text style={s.premiumPillText}>Premium</Text>
                </View>
              </View>
              <Text style={s.cardSubtitle}>
                Describe a dish and Kiwi drafts the ingredients and steps
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={Colors.neutral[600]} />
          </Pressable>

          {/* Create manually — the pre-G3 direct destination, now behind the
              chooser. */}
          <Pressable
            onPress={() => navigateAfterClose("/dish-builder")}
            style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
            testID="add-dish-create-manually"
          >
            <View style={s.cardIcon}>
              <Feather name="edit-3" size={18} color={Colors.sage[700]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Create manually</Text>
              <Text style={s.cardSubtitle}>
                Add ingredients and steps directly
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={Colors.neutral[600]} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: Palette.background.overlay,
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[400],
    alignSelf: "center",
    marginTop: Spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
  },
  body: {
    padding: Spacing[4],
    gap: Spacing[2],
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  askCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  askIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Palette.background.card,
    alignItems: "center",
    justifyContent: "center",
  },
  askTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  cardTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
