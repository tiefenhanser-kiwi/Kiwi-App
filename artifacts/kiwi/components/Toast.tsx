import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";

// WS9 3d Part 3b-2 (D-WS9-001 / D-WS9-011a) — the toast VISUAL. Dumb + stateless:
// it renders the current toast at the TOP of the screen (below the safe-area
// inset) and wraps long text; ALL timing/latch/flush logic lives in
// ToastProvider (contexts/ToastProvider.tsx). Placement is top — bottom got cut
// off on device (Hans's feedback), and center reads as a modal over the content
// being reviewed. Long plan names (the demotion copy carries two) wrap to as
// many lines as needed; the pill grows vertically rather than truncating.

/** Matches the grocery undo banner's 5s window. */
export const TOAST_DEFAULT_DURATION_MS = 5000;

export interface ToastProps {
  message: string;
  /** Undo variant: supply BOTH. Omit for the informational variant. */
  actionLabel?: string;
  onAction?: () => void;
}

export function Toast({ message, actionLabel, onAction }: ToastProps) {
  const insets = useSafeAreaInsets();
  const hasAction = !!actionLabel && !!onAction;
  return (
    <View
      style={[s.wrap, { top: insets.top + Spacing[2] }]}
      pointerEvents="box-none"
    >
      <View style={s.inner}>
        {/* No numberOfLines → the message wraps and the pill grows to fit. */}
        <Text style={s.text}>{message}</Text>
        {hasAction && (
          <Pressable
            onPress={onAction}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            style={({ pressed }) => [pressed && { opacity: 0.7 }]}
          >
            <Text style={s.action}>{actionLabel}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: Spacing[4],
    right: Spacing[4],
    alignItems: "center",
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.neutral[800],
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    width: "100%",
    gap: Spacing[3],
  },
  text: {
    flex: 1,
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.md,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  action: {
    color: Colors.terracotta[300],
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
