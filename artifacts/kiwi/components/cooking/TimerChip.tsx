// WS7-8b Block 4 (Block 1) — shared per-step timer chip.
//
// Lifted VERBATIM from CookSessionView so the Week Prep screen can offer the
// same per-step timers. Renders only on time-bearing steps (estimatedMinutes>0).
// Idle → "⏱ Start M:00 timer" (a single Pressable). Once started, the chip is a
// row carrying the live label plus two explicit controls: "Add a minute"
// (extends — running pushes the end out, done re-arms a fresh 1:00) and "✕"
// (dismiss/clear). The done chip persists until the ✕ is tapped — nothing
// auto-clears, so a finished timer never vanishes while hands are busy. Timing-
// sensitive steps use the warm alert tone on the idle chip.
//
// The `step` prop is widened to the minimal timer-relevant shape so this chip is
// reusable beyond the meal-shaped CookStep (Week Prep steps pass
// isTimingSensitive: false). State + the interval live in useStepTimers.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  formatClock,
  isTimerDone,
  timerRemainingMs,
  type ActiveTimer,
} from "@/lib/cooking/timer";

export function TimerChip({
  step,
  timer,
  nowMs,
  onStart,
  onClear,
  onAddMinute,
}: {
  step: { estimatedMinutes: number; isTimingSensitive: boolean };
  timer: ActiveTimer | undefined;
  nowMs: number;
  onStart: () => void;
  onClear: () => void;
  onAddMinute: () => void;
}) {
  if (step.estimatedMinutes <= 0) return null;
  const sensitive = step.isTimingSensitive;

  if (!timer) {
    return (
      <Pressable
        onPress={onStart}
        style={({ pressed }) => [
          s.chip,
          sensitive ? s.chipAlert : s.chipIdle,
          pressed && { opacity: 0.8 },
        ]}
      >
        <Text style={[s.chipText, sensitive && s.chipTextAlert]}>
          {`⏱ Start ${step.estimatedMinutes}:00 timer`}
        </Text>
      </Pressable>
    );
  }

  const done = isTimerDone(timer, nowMs);
  const label = done
    ? "✓ Timer done"
    : `⏱ ${formatClock(timerRemainingMs(timer, nowMs))}`;
  const labelStyle = done ? s.chipTextDone : s.chipTextRunning;
  const actionStyle = done ? s.chipActionTextDone : s.chipActionText;

  return (
    <View style={[s.chip, done ? s.chipDone : s.chipRunning, s.chipRow]}>
      <Text style={labelStyle}>{label}</Text>
      <Pressable
        onPress={onAddMinute}
        hitSlop={8}
        accessibilityLabel="Add a minute"
        style={({ pressed }) => [s.chipAction, pressed && { opacity: 0.6 }]}
      >
        <Text style={actionStyle}>Add a minute</Text>
      </Pressable>
      <Pressable
        onPress={onClear}
        hitSlop={8}
        accessibilityLabel="Dismiss timer"
        style={({ pressed }) => [s.chipAction, pressed && { opacity: 0.6 }]}
      >
        <Text style={actionStyle}>✕</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[1],
    marginTop: Spacing[2],
    borderWidth: 1,
  },
  chipIdle: {
    backgroundColor: Colors.neutral[0],
    borderColor: Colors.neutral[400],
  },
  chipRunning: {
    backgroundColor: Colors.sage[50],
    borderColor: Colors.sage[300],
  },
  chipDone: {
    backgroundColor: Colors.sage[600],
    borderColor: Colors.sage[600],
  },
  chipAlert: {
    backgroundColor: Palette.cookMode.alert,
    borderColor: Palette.cookMode.alertBorder,
  },
  chipText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  chipTextAlert: { color: Palette.cookMode.alertText },
  chipTextRunning: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  chipTextDone: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  // Started-timer row: live label + the "Add a minute" / "✕" controls.
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  chipAction: {
    paddingHorizontal: Spacing[1],
  },
  // Action labels sit on the running chip (sage on sage[50]) — readable accent.
  chipActionText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  // On the done chip (sage[600] fill) the controls invert to read on the dark tone.
  chipActionTextDone: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
