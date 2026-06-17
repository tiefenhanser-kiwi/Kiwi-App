import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  addDays,
  computeNextWeekStart,
  computeThisWeekStart,
  parseLocalDate,
  toLocalDateString,
} from "@/lib/dates";

export interface PlanDateRangeEditorProps {
  /** ISO "YYYY-MM-DD". Falls back to today's week start when missing. */
  startDate?: string;
  /** ISO "YYYY-MM-DD". Falls back to start + 6 days when missing. */
  endDate?: string;
  onSave: (startDate: string, endDate: string) => void;
}

type PresetKey = "this_week" | "next_week" | "custom";

const MAX_FUTURE_DAYS = 30;
const DURATION_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;

function todayISO(): string {
  return toLocalDateString(new Date());
}

function diffDays(startISO: string, endISO: string): number {
  const a = parseLocalDate(startISO).getTime();
  const b = parseLocalDate(endISO).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function detectPreset(start: string, end: string): PresetKey {
  const dur = diffDays(start, end) + 1;
  if (dur === 7) {
    if (start === computeThisWeekStart()) return "this_week";
    if (start === computeNextWeekStart()) return "next_week";
  }
  return "custom";
}

export function PlanDateRangeEditor({
  startDate,
  endDate,
  onSave,
}: PlanDateRangeEditorProps) {
  const effectiveStart = startDate ?? computeThisWeekStart();
  const effectiveEnd = endDate ?? addDays(effectiveStart, 6);
  const displayLabel = formatDateRange(effectiveStart, effectiveEnd);

  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [s.trigger, pressed && { opacity: 0.7 }]}
        hitSlop={6}
      >
        <Feather name="calendar" size={14} color={Colors.sage[700]} />
        <Text style={s.triggerText}>{displayLabel}</Text>
        <Feather name="edit-2" size={12} color={Colors.sage[700]} />
      </Pressable>
      {open && (
        <DateRangeSheet
          initialStart={effectiveStart}
          initialEnd={effectiveEnd}
          onClose={() => setOpen(false)}
          onSave={(start, end) => {
            onSave(start, end);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

interface SheetProps {
  initialStart: string;
  initialEnd: string;
  onClose: () => void;
  onSave: (start: string, end: string) => void;
}

function DateRangeSheet({
  initialStart,
  initialEnd,
  onClose,
  onSave,
}: SheetProps) {
  const insets = useSafeAreaInsets();

  const today = todayISO();
  const maxEnd = useMemo(() => addDays(today, MAX_FUTURE_DAYS), [today]);

  const [activePreset, setActivePreset] = useState<PresetKey>(() =>
    detectPreset(initialStart, initialEnd),
  );
  // Clamp customStart to today on init — if the saved range starts in
  // the past (e.g. "this week's Sunday" opened mid-week), the stepper's
  // "candidate < today" guard would block both +/- directions and the
  // user couldn't escape. Forward-only from today is the right floor
  // for a date the user is *editing*, even if the underlying plan still
  // points at a past date.
  const [customStart, setCustomStart] = useState(() =>
    initialStart < todayISO() ? todayISO() : initialStart,
  );
  const [customDuration, setCustomDuration] = useState(() => {
    const dur = diffDays(initialStart, initialEnd) + 1;
    return dur >= 1 && dur <= 7 ? dur : 7;
  });
  const [error, setError] = useState<string | null>(null);

  const customEnd = useMemo(
    () => addDays(customStart, customDuration - 1),
    [customStart, customDuration],
  );

  const handleStepStart = (deltaDays: number) => {
    const candidate = addDays(customStart, deltaDays);
    // Don't allow start to drop before today.
    if (candidate < today) return;
    if (addDays(candidate, customDuration - 1) > maxEnd) return;
    setCustomStart(candidate);
    setError(null);
  };

  const handleSave = () => {
    if (activePreset === "this_week") {
      const s = computeThisWeekStart();
      onSave(s, addDays(s, 6));
      return;
    }
    if (activePreset === "next_week") {
      const s = computeNextWeekStart();
      onSave(s, addDays(s, 6));
      return;
    }
    // custom
    if (customDuration < 1 || customDuration > 7) {
      setError("Duration must be between 1 and 7 days.");
      return;
    }
    if (customEnd > maxEnd) {
      setError(`End date can't be more than ${MAX_FUTURE_DAYS} days from today.`);
      return;
    }
    onSave(customStart, customEnd);
  };

  return (
    <Modal
      visible
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View
        style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}
      >
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Plan dates</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={s.presetRow}>
            <PresetButton
              label="This Week"
              active={activePreset === "this_week"}
              onPress={() => {
                setActivePreset("this_week");
                setError(null);
              }}
            />
            <PresetButton
              label="Next Week"
              active={activePreset === "next_week"}
              onPress={() => {
                setActivePreset("next_week");
                setError(null);
              }}
            />
            <PresetButton
              label="Custom"
              active={activePreset === "custom"}
              onPress={() => {
                // Snap customStart to today if it's in the past — otherwise
                // the +/- stepper's "candidate < today" clamp blocks both
                // directions (e.g. a stale "this week's Sunday" mid-week
                // is already past, so neither -1 nor +1 lands on/after
                // today). Same guard for an out-of-range duration.
                if (!customStart || customStart < today) {
                  setCustomStart(today);
                }
                if (customDuration < 1 || customDuration > 7) {
                  setCustomDuration(7);
                }
                setActivePreset("custom");
                setError(null);
              }}
            />
          </View>

          {activePreset === "custom" && (
            <View style={s.customWrap}>
              <Text style={s.fieldLabel}>Start date</Text>
              <View style={s.stepperRow}>
                <Pressable
                  onPress={() => handleStepStart(-1)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    s.stepperBtn,
                    customStart <= today && { opacity: 0.4 },
                    pressed && { opacity: 0.6 },
                  ]}
                  disabled={customStart <= today}
                >
                  <Feather name="minus" size={16} color={Colors.sage[700]} />
                </Pressable>
                <Text style={s.stepperValue}>
                  {formatDate(customStart)}
                </Text>
                <Pressable
                  onPress={() => handleStepStart(1)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    s.stepperBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Feather name="plus" size={16} color={Colors.sage[700]} />
                </Pressable>
              </View>
              <Text style={s.fieldHint}>
                {customStart === today
                  ? "Today"
                  : `${diffDays(today, customStart)} day${diffDays(today, customStart) === 1 ? "" : "s"} from today`}
              </Text>

              <Text style={[s.fieldLabel, { marginTop: Spacing[4] }]}>
                Duration
              </Text>
              <View style={s.durationRow}>
                {DURATION_OPTIONS.map((n) => (
                  <Pressable
                    key={n}
                    onPress={() => {
                      setCustomDuration(n);
                      setError(null);
                    }}
                    style={({ pressed }) => [
                      s.durationChip,
                      customDuration === n && s.durationChipActive,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text
                      style={[
                        s.durationChipText,
                        customDuration === n && s.durationChipTextActive,
                      ]}
                    >
                      {n}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.fieldHint}>
                {customDuration} day{customDuration === 1 ? "" : "s"} · ends{" "}
                {formatDate(customEnd)}
              </Text>
            </View>
          )}

          {error && <Text style={s.errorText}>{error}</Text>}
        </ScrollView>

        <View style={s.footer}>
          <Pressable
            onPress={handleSave}
            style={({ pressed }) => [
              s.saveBtn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={s.saveBtnText}>Save</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function PresetButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.presetBtn,
        active && s.presetBtnActive,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[s.presetBtnText, active && s.presetBtnTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  triggerText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    maxHeight: "85%",
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
    fontFamily: Typography.face.serif[600],
  },
  scrollContent: {
    padding: Spacing[4],
    gap: Spacing[3],
  },
  presetRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  presetBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: Spacing[2],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    alignItems: "center",
  },
  presetBtnActive: {
    backgroundColor: Colors.sage[700],
    borderColor: Colors.sage[700],
  },
  presetBtnText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  presetBtnTextActive: {
    color: Colors.neutral[0],
  },
  customWrap: {
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    borderRadius: Radius.md,
    padding: Spacing[3],
    gap: Spacing[2],
  },
  fieldLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  fieldHint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Colors.neutral[100],
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: 6,
    alignSelf: "flex-start",
  },
  stepperBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    minWidth: 80,
    textAlign: "center",
  },
  durationRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  durationChip: {
    minWidth: 36,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Colors.neutral[100],
    alignItems: "center",
  },
  durationChipActive: {
    backgroundColor: Colors.sage[700],
    borderColor: Colors.sage[700],
  },
  durationChipText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  durationChipTextActive: {
    color: Colors.neutral[0],
  },
  errorText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[400],
  },
  footer: {
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    backgroundColor: Colors.neutral[100],
  },
  saveBtn: {
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  saveBtnText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
