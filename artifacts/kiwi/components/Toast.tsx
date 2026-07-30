import React, { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";

// WS9 3d Part 1a (D-WS9-001 / D-WS9-011a) — the app's first reusable toast.
// Generalized from the hand-rolled grocery-list undo banner
// (app/grocery-list/[id].tsx: undoBanner* styles, UNDO_TIMEOUT_MS = 5000) so
// the whole app keeps one toast look + one interaction feel. Two variants:
//
//   • Undo — message + an Undo action. Auto-dismisses on timeout; pressing the
//     action cancels the timer. onAction (undo pressed) and onDismiss (timed
//     out / dismissed WITHOUT action) are SEPARATE callbacks precisely so a
//     deferred-destructive caller can tell "user changed their mind" (onAction)
//     from "toast expired → commit the destructive op" (onDismiss).
//   • Informational — message only, auto-dismisses, no action.
//
// The parent owns `visible`; both callbacks fire exactly once per showing and
// the parent flips `visible` to false in each. The auto-dismiss timer lives
// INSIDE this component (keyed on visible + message) so every caller gets
// the same 5s behavior and unmount-safety for free — no per-screen effect.

/** Matches the grocery undo banner's 5s window (UNDO_TIMEOUT_MS). */
export const TOAST_DEFAULT_DURATION_MS = 5000;

export interface ToastProps {
  visible: boolean;
  message: string;
  /** Undo variant: supply BOTH actionLabel and onAction. Omit for the
   *  informational variant (message only). */
  actionLabel?: string;
  onAction?: () => void;
  /** Fired when the toast auto-dismisses (timeout) — i.e. dismissed WITHOUT
   *  the action being pressed. Not fired when onAction fires. */
  onDismiss: () => void;
  /** Auto-dismiss timeout. Defaults to the shared 5s window. */
  durationMs?: number;
}

export function Toast({
  visible,
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = TOAST_DEFAULT_DURATION_MS,
}: ToastProps) {
  const hasAction = !!actionLabel && !!onAction;

  // Latch the callback in a ref so the timeout effect can depend only on the
  // showing identity (visible + message), never re-arming just because the
  // parent passed a new closure. This is what keeps sequential toasts from
  // leaking timers: a new message tears down the old timer and starts one.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Live timer id + a per-showing "settled" latch. The latch makes both
  // "action cancels the timeout" and "no double-fire" component-level
  // guarantees rather than relying on the parent flipping `visible`: once the
  // action fires (or the timeout fires) this showing is settled and the other
  // callback can never fire for it.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    settledRef.current = false;
    timeoutRef.current = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      onDismissRef.current();
    }, durationMs);
    // Cleanup fires on unmount, on visible→false, and before a re-arm when the
    // message changes — so there is never more than one live timer, and an
    // unmount mid-timeout cannot fire onDismiss.
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [visible, message, durationMs]);

  const handleAction = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    onAction?.();
  };

  if (!visible) return null;

  return (
    <View style={s.wrap} pointerEvents="box-none">
      <View style={s.inner}>
        <Text style={s.text} numberOfLines={2}>
          {message}
        </Text>
        {hasAction && (
          <Pressable
            onPress={handleAction}
            hitSlop={6}
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

// Styles carried over 1:1 from the grocery undo banner (undoBanner*,
// app/grocery-list/[id].tsx:1631-1670) so the two surfaces read identically.
const s = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: Spacing[4],
    right: Spacing[4],
    bottom: Spacing[4],
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
