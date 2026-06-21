// WS7-8b Block 3 — single-meal Cook Mode presentation (design spec §2.2, PRD
// §13.5.1 / §7.12). Pure/presentational: the route (app/cook-session.tsx) owns
// the hooks (useMeal/useDish/usePlan), the prep-gate decision, and the engine
// state; this renders. Kept render-only so it's testable in node:test.
//
// Scroll-anchor engine: the CURRENT step is tracked by `currentIndex` (route
// state), independent of scroll position — free-scrolling never loses the
// anchor. An onLayout offset map drives an auto-scroll back to the anchor when
// currentIndex changes (guarded; a no-op under the test renderer).

import React, { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import * as Haptics from "expo-haptics";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";
import {
  formatClock,
  highlightQuantities,
  isTimerDone,
  timerRemainingMs,
  type ActiveTimer,
  type CookStep,
} from "@/lib/cooking/cookSession";

interface Props {
  title: string;
  /** Active (prep-filtered when on the prepped path) ordered steps. */
  steps: CookStep[];
  currentIndex: number;
  /** Prepped path → render the mise-en-place recap card above the steps. */
  prepped: boolean;
  /** State 1 (known prepped) → the recap carries the sage "you prepped" framing. */
  showSkipBar: boolean;
  recapItems: string[];
  remainingMins: number;
  onAdvance: () => void;
  onPrevStep: () => void;
  onSelectStep: (index: number) => void;
  onSkipToCooking: () => void;
  /** State 3 unanswered → block the session with the one-tap gate. */
  gatePromptVisible: boolean;
  onPrepAnswer: (prepped: boolean) => void;
  toastVisible: boolean;
  onExit: () => void;
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// First couple of words, for the active-timer strip label when there's no dish.
function shortLabel(text: string): string {
  return text.split(/\s+/).slice(0, 2).join(" ");
}

// Per-step timer chip. Renders only on time-bearing steps (estimatedMinutes>0).
// Idle → "⏱ Start M:00 timer" (a single Pressable). Once started, the chip is a
// row carrying the live label plus two explicit controls (polish #4): "Add a
// minute" (extends — running pushes the end out, done re-arms a fresh 1:00) and
// "✕" (dismiss/clear). The done chip persists until the ✕ is tapped — nothing
// auto-clears, so a finished timer never vanishes while hands are busy.
// Timing-sensitive steps use the warm alert tone on the idle chip.
function TimerChip({
  step,
  timer,
  nowMs,
  onStart,
  onClear,
  onAddMinute,
}: {
  step: CookStep;
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

// Renders step text with quantities bolded terracotta. Best-effort + lossless:
// highlightQuantities guarantees the segments rejoin to the original string.
function StepText({ text, style }: { text: string; style: object }) {
  const segments = highlightQuantities(text);
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.isQuantity ? (
          <Text key={i} style={s.quantity}>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}

export function CookSessionView({
  title,
  steps,
  currentIndex,
  prepped,
  showSkipBar,
  recapItems,
  remainingMins,
  onAdvance,
  onPrevStep,
  onSelectStep,
  onSkipToCooking,
  gatePromptVisible,
  onPrepAnswer,
  toastVisible,
  onExit,
}: Props) {
  const scrollRef = useRef<ScrollView | null>(null);
  const offsets = useRef<Record<number, number>>({});

  // ── Per-step timers (keyed by stable step.key, NOT index — survives the
  // prep-gate re-filter). One wall-clock `endsAt` per timer + one ticking
  // `nowMs`; every chip derives remaining = endsAt - now, so concurrency and
  // continuation-while-navigating are inherent (a timer keeps counting no matter
  // which step is the anchor). ──────────────────────────────────────────────
  const [timers, setTimers] = useState<Record<string, ActiveTimer>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const firedRef = useRef<Set<string>>(new Set());

  const hasActiveTimers = Object.keys(timers).length > 0;

  // One shared 1s tick, only while at least one timer is running.
  useEffect(() => {
    if (!hasActiveTimers) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveTimers]);

  // Completion: a single success haptic per timer, guarded so it fires once.
  useEffect(() => {
    for (const [key, timer] of Object.entries(timers)) {
      if (isTimerDone(timer, nowMs) && !firedRef.current.has(key)) {
        firedRef.current.add(key);
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
      }
    }
  }, [nowMs, timers]);

  const startTimer = (step: CookStep) => {
    const durationMs = step.estimatedMinutes * 60_000;
    if (durationMs <= 0) return;
    const now = Date.now();
    firedRef.current.delete(step.key); // re-arm if restarted
    // Stamp `now` to the same instant as endsAt so the chip shows the exact
    // starting value immediately (e.g. "5:00", not "4:59") before the 1s tick.
    setNowMs(now);
    setTimers((t) => ({
      ...t,
      [step.key]: { endsAt: now + durationMs, durationMs },
    }));
  };
  const clearTimer = (key: string) => {
    firedRef.current.delete(key);
    setTimers((t) => {
      const next = { ...t };
      delete next[key];
      return next;
    });
  };
  // Polish #4 (D-WS7-165) — "Add a minute", state-dependent:
  //   • running timer → push the original end out by a minute (endsAt + 60s).
  //   • done timer    → re-arm to a fresh 1:00 from now (now + 60s).
  // Either way re-arm the completion haptic and refresh `nowMs` so the chip
  // updates on the same tap.
  const extendTimer = (key: string) => {
    const now = Date.now();
    setTimers((t) => {
      const cur = t[key];
      if (!cur) return t;
      const endsAt = isTimerDone(cur, now) ? now + 60_000 : cur.endsAt + 60_000;
      return { ...t, [key]: { endsAt, durationMs: cur.durationMs + 60_000 } };
    });
    firedRef.current.delete(key);
    setNowMs(now);
  };

  if (gatePromptVisible) {
    return (
      <View style={s.bg}>
        <Header showBack title="Cook" onBack={onExit} />
        <View style={s.gateWrap}>
          <View style={s.gateCard}>
            <Text style={s.gateHeading}>Did you prep this already?</Text>
            <Text style={s.gateBody}>
              If you knocked out the chopping and prep ahead of time, we&apos;ll
              jump you straight to cooking.
            </Text>
            <View style={s.gateActions}>
              <Button
                label="Yes, I prepped"
                variant="primary"
                onPress={() => onPrepAnswer(true)}
              />
              <Button
                label="No, start from prep"
                variant="secondary"
                onPress={() => onPrepAnswer(false)}
              />
            </View>
          </View>
        </View>
      </View>
    );
  }

  const total = steps.length;
  const next = steps[currentIndex + 1];
  const nextLabel = next
    ? next.dishTitle ?? capitalize(next.phaseType)
    : null;
  const onLast = currentIndex >= total - 1;

  // Active-timer strip data (§13.5.1). One compact pill per running/done timer,
  // labelled by its step (dish title, else the first words of the step).
  const timerEntries = Object.entries(timers).map(([key, timer]) => {
    const step = steps.find((st) => st.key === key);
    const label = step?.dishTitle ?? (step ? shortLabel(step.text) : "Timer");
    return {
      key,
      label,
      remaining: timerRemainingMs(timer, nowMs),
      done: isTimerDone(timer, nowMs),
    };
  });

  return (
    <View style={s.bg}>
      <Header showBack title={title} onBack={onExit} />

      {/* Progress segments: done = sage, current = terracotta, upcoming = neutral. */}
      <View style={s.segments}>
        {steps.map((step, i) => (
          <View
            key={step.key}
            style={[
              s.segment,
              i < currentIndex && s.segmentDone,
              i === currentIndex && s.segmentCurrent,
              i > currentIndex && s.segmentUpcoming,
            ]}
          />
        ))}
      </View>

      {/* Italic-dash Fraunces section label. */}
      <Text style={s.sectionLabel}>
        {total > 0 ? `— step ${currentIndex + 1} of ${total} —` : "— the cook —"}
      </Text>

      {/* Persistent active-timer strip (§13.5.1). */}
      {timerEntries.length > 0 && (
        <View style={s.timerStrip}>
          {timerEntries.map((entry) => (
            <View
              key={entry.key}
              style={[s.timerPill, entry.done && s.timerPillDone]}
            >
              <Text style={s.timerPillText}>
                {entry.done
                  ? `🔔 ${entry.label} done`
                  : `🟢 ${entry.label} ${formatClock(entry.remaining)}`}
              </Text>
            </View>
          ))}
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Mise-en-place recap (prepped path). Render-only; reads prep-step
            text for display. Sits above the steps — scroll-reachable. */}
        {prepped && (
          <View style={[s.recap, showSkipBar && s.recapSkip]}>
            <Text style={s.recapHeading}>
              You already prepped this — get your:
            </Text>
            {recapItems.length > 0 ? (
              recapItems.map((item, i) => (
                <Text key={i} style={s.recapItem}>
                  • {item}
                </Text>
              ))
            ) : (
              <Text style={s.recapItem}>Everything from your prep session.</Text>
            )}
            <View style={s.skipBtnWrap}>
              <Button
                label="Skip to cooking"
                variant="secondary"
                onPress={onSkipToCooking}
              />
            </View>
          </View>
        )}

        {steps.map((step, i) => {
          const isCurrent = i === currentIndex;
          const isDone = i < currentIndex;
          return (
            <Pressable
              key={step.key}
              testID={`step-${i}`}
              onPress={() => onSelectStep(i)}
              onLayout={(e: LayoutChangeEvent) => {
                offsets.current[i] = e.nativeEvent.layout.y;
              }}
              style={({ pressed }) => [
                s.stepCard,
                isCurrent && s.stepCurrent,
                isDone && s.stepDone,
                !isCurrent && !isDone && s.stepUpcoming,
                pressed && isCurrent && { opacity: 0.9 },
              ]}
            >
              {isDone && <Text style={s.doneMark}>✓ done</Text>}
              {step.dishTitle && <Text style={s.dishTag}>{step.dishTitle}</Text>}
              {/* Sequencer parallel cue (server `reason`) — a suggestion, never
                  blocking (§13.9). Plain annotation on a real step. */}
              {step.cue && <Text style={s.cue}>{step.cue}</Text>}
              <StepText
                text={step.text}
                style={isCurrent ? s.stepTextCurrent : s.stepText}
              />
              {step.estimatedMinutes > 0 && (
                <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
              )}
              <TimerChip
                step={step}
                timer={timers[step.key]}
                nowMs={nowMs}
                onStart={() => startTimer(step)}
                onClear={() => clearTimer(step.key)}
                onAddMinute={() => extendTimer(step.key)}
              />
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Footer: back + advance, with the dimmed next preview. */}
      <View style={s.footer}>
        {nextLabel && (
          <Text style={s.nextPreview}>Next · {nextLabel}</Text>
        )}
        {remainingMins > 0 && (
          <Text style={s.remaining}>~{remainingMins} min left</Text>
        )}
        <View style={s.footerRow}>
          <View style={s.footerBack}>
            <Button
              label="←"
              variant="secondary"
              disabled={currentIndex <= 0}
              onPress={onPrevStep}
              fullWidth={false}
            />
          </View>
          {!onLast && (
            <View style={s.footerNext}>
              <Button
                label="Done — next step"
                variant="primary"
                onPress={onAdvance}
              />
            </View>
          )}
        </View>
      </View>

      {toastVisible && (
        <View style={s.toast} pointerEvents="none">
          <Text style={s.toastText}>Way to go! Nice work, you-in-the-past!</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },

  // gate
  gateWrap: { flex: 1, justifyContent: "center", paddingHorizontal: Spacing[4] },
  gateCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[5],
    gap: Spacing[3],
    ...Shadow.card,
  },
  gateHeading: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  gateBody: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: Typography.face.sans[400],
  },
  gateActions: { gap: Spacing[2], marginTop: Spacing[2] },

  // progress segments
  segments: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  segmentDone: { backgroundColor: Colors.sage[600] },
  segmentCurrent: { backgroundColor: Colors.terracotta[400] },
  segmentUpcoming: { backgroundColor: Colors.neutral[300] },

  sectionLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[400],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[500],
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
    paddingBottom: Spacing[1],
  },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
    paddingBottom: Spacing[8],
    gap: Spacing[2],
  },

  // recap
  recap: {
    backgroundColor: Colors.neutral[0],
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[4],
    gap: Spacing[1],
    marginBottom: Spacing[2],
    ...Shadow.card,
  },
  recapSkip: {
    backgroundColor: Colors.sage[50],
    borderColor: Palette.border.sage,
  },
  recapHeading: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[1],
  },
  recapItem: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  skipBtnWrap: { marginTop: Spacing[3] },

  // steps
  stepCard: {
    borderRadius: Radius.xl,
    padding: Spacing[4],
  },
  stepCurrent: {
    backgroundColor: Colors.neutral[0],
    borderWidth: 1,
    borderColor: Palette.border.default,
    ...Shadow.card,
  },
  stepDone: { opacity: 0.42 },
  stepUpcoming: { opacity: 0.5 },
  doneMark: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[1],
  },
  dishTag: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[400],
    marginBottom: Spacing[1],
  },
  // Sequencer parallel cue — sage italic, distinct from the neutral dishTag and
  // the terracotta current/quantity accents. A calm "while you wait" suggestion.
  cue: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[400],
    lineHeight: 20,
    marginBottom: Spacing[1],
  },
  stepText: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 26,
  },
  stepTextCurrent: {
    fontSize: Typography.fontSize.cookStep,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[400],
    lineHeight: 30,
  },
  quantity: {
    color: Palette.cookMode.quantity.color,
    fontWeight: Palette.cookMode.quantity.fontWeight,
    fontFamily: Typography.face.sans[700],
  },
  stepMeta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[2],
  },

  // timer chip
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
  // Started-timer row: live label + the "Add a minute" / "✕" controls (#4).
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

  // active-timer strip
  timerStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[1],
    paddingHorizontal: Spacing[4],
    paddingBottom: Spacing[1],
  },
  timerPill: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: 2,
  },
  timerPillDone: {
    backgroundColor: Palette.cookMode.alert,
    borderColor: Palette.cookMode.alertBorder,
  },
  timerPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },

  // footer
  footer: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
    paddingBottom: Spacing[4],
    borderTopWidth: 1,
    borderTopColor: Palette.border.default,
    backgroundColor: Colors.neutral[100],
    gap: Spacing[1],
  },
  nextPreview: {
    fontSize: Typography.fontSize.sm,
    color: Palette.cookMode.nextPreview,
    fontFamily: Typography.face.sans[400],
  },
  remaining: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  footerRow: { flexDirection: "row", gap: Spacing[2], marginTop: Spacing[1] },
  footerBack: { width: 64 },
  footerNext: { flex: 1 },

  // toast (#4 — polish #2): the View is now a transparent full-screen centering
  // layer (pointerEvents="none", so it never blocks taps) and the Text carries
  // the green pill. This is the seam that lets us center on screen rather than
  // bottom-anchor while restyling only these two rules — the JSX is untouched.
  toast: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: Spacing[6], // keeps the pill clear of the screen edges
  },
  // Bigger height (more vertical padding) + a little less wide (maxWidth) +
  // centered (via the layer above). Copy literal is untouched.
  toastText: {
    maxWidth: 320,
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.lg,
    paddingVertical: Spacing[5],
    paddingHorizontal: Spacing[5],
    overflow: "hidden", // clip the rounded corners around the Text fill
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textAlign: "center",
    ...Shadow.overlay,
  },
});
