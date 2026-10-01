// WS7-8b Block 4 (Block 1) — shared per-step timer chip.
//
// Lifted from CookSessionView. Renders only on time-bearing steps
// (estimatedMinutes>0).
//
// ⚠️ THE WEEK PREP SCREEN DOES NOT USE THIS. The original header said it was
// extracted "so the Week Prep screen can offer the same per-step timers"; that
// never happened. Verified Sept 30: TimerChip has exactly ONE importer,
// components/CookSessionView.tsx. So this file is Cook-Mode-only, and a change
// here has no Prep-the-Week blast radius -- which is why the Sept 29 design
// review could re-glyph it without crossing into another lane's fence.
// Idle → a clock glyph + "Start M:00 timer" (a single Pressable). Once started,
// the chip is a row carrying the live label plus two explicit controls: "Add a
// minute" (extends — running pushes the end out, done re-arms a fresh 1:00) and
// an × (dismiss/clear). The done chip persists until the × is tapped — nothing
// auto-clears, so a finished timer never vanishes while hands are busy. Timing-
// sensitive steps use the warm alert tone on the idle chip.
//
// ⚠️ ICONS ARE FEATHER, NOT EMOJI (D-WS9-162; Sept 29 design review). ⏱ / ✓ / ✕
// were text glyphs, which meant they rendered at the system emoji font's whim,
// ignored the chip's own colour, and announced as their unicode names. Each is
// now a <Feather> at the label's size, tinted with the label's colour, inside a
// row — so the icon and the text stay one object in every state.
//
// The `step` prop is widened to the minimal timer-relevant shape so this chip is
// reusable beyond the meal-shaped CookStep (Week Prep steps pass
// isTimingSensitive: false). State + the interval live in useStepTimers.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

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
        // Sept 29 design review — the START chip had NO hitSlop at all, and it
        // is the one control here you reach for with wet or full hands. 12 a
        // side on all three controls in this file.
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`Start a ${step.estimatedMinutes} minute timer`}
        style={({ pressed }) => [
          s.chip,
          sensitive ? s.chipAlert : s.chipIdle,
          pressed && { opacity: 0.8 },
        ]}
      >
        <View style={s.labelRow}>
          <Feather
            name="clock"
            size={ICON}
            color={sensitive ? Palette.cookMode.alertText : Colors.neutral[800]}
          />
          <Text style={[s.chipText, sensitive && s.chipTextAlert]}>
            {`Start ${step.estimatedMinutes}:00 timer`}
          </Text>
        </View>
      </Pressable>
    );
  }

  const done = isTimerDone(timer, nowMs);
  const label = done ? "Timer done" : formatClock(timerRemainingMs(timer, nowMs));
  const labelStyle = done ? s.chipTextDone : s.chipTextRunning;
  const actionStyle = done ? s.chipActionTextDone : s.chipActionText;
  // The icon takes the LABEL's colour in both states — on the done chip that is
  // cream on sage[600], on the running chip sage[700] on sage[50]. A hard-coded
  // tint would have been invisible on one of the two.
  const iconColor = done ? Colors.neutral[0] : Colors.sage[700];

  return (
    <View style={[s.chip, done ? s.chipDone : s.chipRunning, s.chipRow]}>
      <View style={s.labelRow}>
        <Feather
          name={done ? "check-circle" : "clock"}
          size={ICON}
          color={iconColor}
        />
        <Text style={labelStyle}>{label}</Text>
      </View>
      <Pressable
        onPress={onAddMinute}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Add a minute"
        style={({ pressed }) => [s.chipAction, pressed && { opacity: 0.6 }]}
      >
        <Text style={actionStyle}>Add a minute</Text>
      </Pressable>
      <Pressable
        onPress={onClear}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Dismiss timer"
        style={({ pressed }) => [s.chipAction, pressed && { opacity: 0.6 }]}
      >
        <Feather name="x" size={ICON} color={iconColor} />
      </Pressable>
    </View>
  );
}

// Matched to fontSize.sm (12), which every label in this file uses. Sized to
// the text rather than to a token scale so the icon reads as part of the word.
const ICON = 13;

const s = StyleSheet.create({
  // Icon + text as one unit. `gap` replaces the space that used to follow the
  // emoji, so the optical spacing is a layout value rather than a character.
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
  },
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
