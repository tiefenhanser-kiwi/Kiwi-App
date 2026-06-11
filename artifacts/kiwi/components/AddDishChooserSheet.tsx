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

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

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
      <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Add a dish</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={KColors.neutral[800]} />
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
              <Feather name="zap" size={18} color={KColors.sage[700]} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={s.askTitleRow}>
                <Text style={s.cardTitle}>Ask Kiwi</Text>
                <View style={s.premiumPill}>
                  <Feather
                    name="lock"
                    size={10}
                    color={KColors.terracotta[700]}
                  />
                  <Text style={s.premiumPillText}>Premium</Text>
                </View>
              </View>
              <Text style={s.cardSubtitle}>
                Describe a dish and Kiwi drafts the ingredients and steps
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={KColors.neutral[600]} />
          </Pressable>

          {/* Create manually — the pre-G3 direct destination, now behind the
              chooser. */}
          <Pressable
            onPress={() => navigateAfterClose("/dish-builder")}
            style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
            testID="add-dish-create-manually"
          >
            <View style={s.cardIcon}>
              <Feather name="edit-3" size={18} color={KColors.sage[700]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Create manually</Text>
              <Text style={s.cardSubtitle}>
                Add ingredients and steps directly
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={KColors.neutral[600]} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
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
  body: {
    padding: KSpacing.lg,
    gap: KSpacing.sm,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  askCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  askIcon: {
    width: 36,
    height: 36,
    borderRadius: KRadius.sm,
    backgroundColor: KPalette.bg.card,
    alignItems: "center",
    justifyContent: "center",
  },
  askTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  cardTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
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
});
