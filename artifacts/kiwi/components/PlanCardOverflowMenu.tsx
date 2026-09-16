import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// WS9 3d Part 1c (D-WS9-001 / D-WS9-008) — the plan-card "⋯" overflow host.
// The app had no kebab/action-sheet affordance anywhere (Phase 0). Scope guard
// (Hans): this hosts EXACTLY two items this block — Use again and Compost — and
// is deliberately NOT a general-purpose menu framework. Each item renders only
// when its handler is supplied, so a plan with no backing template can drop
// "Use again" by omitting onUseAgain (Compost is always available on a saved
// plan). Compost gets the destructive (terracotta) treatment.
//
// WS9 Redesign Arc Block 2b — the Playlist row needs the same "⋯" → sheet
// affordance with two DIFFERENT items (View meal · Remove from playlist).
// Rather than a second copy of the trigger + Modal + sheet, the host takes an
// optional `items` list; when supplied it renders those and the two plan props
// are ignored. The plan-card API is byte-for-byte unchanged.

export interface OverflowMenuItem {
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  onPress: () => void;
  /** Terracotta treatment (the Compost idiom). */
  destructive?: boolean;
}

export interface PlanCardOverflowMenuProps {
  /** Block 2b — generic items. When given, onUseAgain / onCompost are ignored. */
  items?: OverflowMenuItem[];
  /** Fired when "Use again" is chosen. Omit to hide the item (e.g. a plan with
   *  no backing MealPlanTemplate to copy from). */
  onUseAgain?: () => void;
  /** Fired when "Compost" is chosen. Omit to hide the item. */
  onCompost?: () => void;
  /** Accessibility label for the "⋯" trigger. */
  accessibilityLabel?: string;
}

export function PlanCardOverflowMenu({
  items,
  onUseAgain,
  onCompost,
  accessibilityLabel = "Plan actions",
}: PlanCardOverflowMenuProps) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const resolved: OverflowMenuItem[] =
    items ??
    [
      ...(onUseAgain
        ? [{ label: "Use again", icon: "copy" as const, onPress: onUseAgain }]
        : []),
      ...(onCompost
        ? [{ label: "Compost", icon: "trash-2" as const, onPress: onCompost, destructive: true }]
        : []),
    ];
  // Nothing to show → render no trigger at all (keeps template rows / plans
  // with no offered action clean).
  if (resolved.length === 0) return null;

  const choose = (handler: () => void) => {
    setOpen(false);
    // Defer so the sheet's slide-out completes before the handler's own
    // dialog/toast/navigation mounts (mirrors the sheet pattern used across
    // AddMealsSheet / SwapMealSheet).
    setTimeout(handler, 150);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [s.trigger, pressed && { opacity: 0.6 }]}
      >
        <Feather name="more-horizontal" size={20} color={Colors.neutral[700]} />
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
          <View style={s.handle} />
          {resolved.map((item) => (
            <Pressable
              key={item.label}
              onPress={() => choose(item.onPress)}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              style={({ pressed }) => [s.item, pressed && { opacity: 0.7 }]}
            >
              <Feather
                name={item.icon}
                size={18}
                color={item.destructive ? Colors.terracotta[600] : Colors.neutral[800]}
              />
              <Text style={[s.itemText, item.destructive && s.itemTextDestructive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  trigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
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
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[400],
    alignSelf: "center",
    marginBottom: Spacing[2],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    paddingVertical: Spacing[3],
  },
  itemText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  itemTextDestructive: {
    color: Colors.terracotta[600],
  },
});
