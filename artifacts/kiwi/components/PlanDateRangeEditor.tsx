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

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
        <Feather name="calendar" size={14} color={KColors.sage[700]} />
        <Text style={s.triggerText}>{displayLabel}</Text>
        <Feather name="edit-2" size={12} color={KColors.sage[700]} />
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
        style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}
      >
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Plan dates</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={KColors.neutral[800]} />
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
                  <Feather name="minus" size={16} color={KColors.sage[700]} />
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
                  <Feather name="plus" size={16} color={KColors.sage[700]} />
                </Pressable>
              </View>
              <Text style={s.fieldHint}>
                {customStart === today
                  ? "Today"
                  : `${diffDays(today, customStart)} day${diffDays(today, customStart) === 1 ? "" : "s"} from today`}
              </Text>

              <Text style={[s.fieldLabel, { marginTop: KSpacing.lg }]}>
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
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
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
    backgroundColor: KColors.neutral[100],
    borderTopLeftRadius: KRadius.xl,
    borderTopRightRadius: KRadius.xl,
    maxHeight: "85%",
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
    gap: KSpacing.md,
  },
  presetRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  presetBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: KSpacing.sm,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KPalette.bg.card,
    alignItems: "center",
  },
  presetBtnActive: {
    backgroundColor: KColors.sage[700],
    borderColor: KColors.sage[700],
  },
  presetBtnText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_600SemiBold",
    fontWeight: KType.weight.semibold,
  },
  presetBtnTextActive: {
    color: KColors.neutral[0],
  },
  customWrap: {
    backgroundColor: KPalette.bg.card,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    gap: KSpacing.sm,
  },
  fieldLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  fieldHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[100],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
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
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
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
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[100],
    alignItems: "center",
  },
  durationChipActive: {
    backgroundColor: KColors.sage[700],
    borderColor: KColors.sage[700],
  },
  durationChipText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  durationChipTextActive: {
    color: KColors.neutral[0],
  },
  errorText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[600],
    fontFamily: "Inter_400Regular",
  },
  footer: {
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderTopWidth: 1,
    borderTopColor: KColors.neutral[300],
    backgroundColor: KColors.neutral[100],
  },
  saveBtn: {
    backgroundColor: KColors.sage[700],
    borderRadius: KRadius.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  saveBtnText: {
    fontSize: KType.size.md,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
