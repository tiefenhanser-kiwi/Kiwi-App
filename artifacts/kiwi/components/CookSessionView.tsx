// WS7-8b Block 3 — single-meal Cook Mode presentation (design spec §2.2, PRD
// §13.5.1 / §7.12). Pure/presentational: the route (app/cook-session.tsx) owns
// the hooks (useMeal/useDish/usePlan), the prep-gate decision, and the engine
// state; this renders. Kept render-only so it's testable in node:test.
//
// Scroll-anchor engine: the CURRENT step is tracked by `currentIndex` (route
// state), independent of scroll position — free-scrolling never loses the
// anchor. An onLayout offset map drives an auto-scroll back to the anchor when
// currentIndex changes (guarded; a no-op under the test renderer).

import React, { useRef } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { Button } from "@/components/Button";
import { CookFooter } from "@/components/cooking/CookFooter";
import { HighlightedText } from "@/components/cooking/HighlightedText";
import { ProgressSegments } from "@/components/cooking/ProgressSegments";
import { TimerChip } from "@/components/cooking/TimerChip";
import { Header } from "@/components/Header";
import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { useStepTimers } from "@/hooks/useStepTimers";
import {
  formatClock,
  isTimerDone,
  timerRemainingMs,
} from "@/lib/cooking/timer";
import type { CookStep } from "@/lib/cooking/cookSession";
import { buildAmountRefSegments } from "@/lib/cooking/amountSegments";
import type { AmountRef } from "@/lib/api/meals";

interface Props {
  title: string;
  /** Active (prep-filtered when on the prepped path) ordered steps. */
  steps: CookStep[];
  /** WS7-8b BUG-006 — multiplier amountRef spans render through, so Cook Mode
   *  scales to the plan's effectiveServings (matching Meal Detail). 1 = base. */
  amountMultiplier: number;
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

// Renders step text with quantities bolded terracotta.
// WS7-8b BUG-003 Block 1 — ref-bearing steps render the structured amount
// (multiplier 1: Cook Mode shows the base structured value, not a scaled one)
// and bypass the regex. Legacy/no-ref steps keep highlightQuantities, whose
// segments losslessly rejoin to the original string.
function StepText({
  text,
  amountRefs,
  amountMultiplier,
  style,
}: {
  text: string;
  amountRefs?: AmountRef[] | null;
  amountMultiplier: number;
  style: object;
}) {
  if (amountRefs && amountRefs.length > 0) {
    return (
      <Text style={style}>
        {buildAmountRefSegments(text, amountRefs, amountMultiplier).map((seg, i) =>
          seg.isRef ? (
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
  // Legacy/no-ref steps: the shared regex highlighter (segments rejoin losslessly).
  return <HighlightedText text={text} style={style} />;
}

export function CookSessionView({
  title,
  steps,
  amountMultiplier,
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
  // prep-gate re-filter). State + the 1s tick + the completion haptic live in
  // the shared useStepTimers hook (WS7-8b Block 4 extraction); the strip and the
  // chips both read from this one source of truth. ───────────────────────────
  const { timers, nowMs, startTimer, clearTimer, extendTimer } = useStepTimers();

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
      <ProgressSegments segmentCount={total} currentIndex={currentIndex} />

      {/* Italic-dash Fraunces section label. */}
      <Text style={s.sectionLabel}>
        {total > 0 ? `— step ${currentIndex + 1} of ${total} —` : "— the cook —"}
      </Text>

      {/* Persistent active-timer strip (§13.5.1). Each pill carries the same two
          controls as the per-step chip (#2) — "+1 min" and "✕" — wired to the
          shared extendTimer/clearTimer handlers so a timer can be extended or
          dismissed from the top without scrolling to its step. extendTimer
          already branches running-vs-done internally, so both apply in either
          state (running → push out / done → re-arm; either → dismiss). */}
      {timerEntries.length > 0 && (
        <View style={s.timerStrip}>
          {timerEntries.map((entry) => (
            <View
              key={entry.key}
              style={[s.timerPill, entry.done && s.timerPillDone, s.timerPillRow]}
            >
              <Text style={s.timerPillText}>
                {entry.done
                  ? `🔔 ${entry.label} done`
                  : `🟢 ${entry.label} ${formatClock(entry.remaining)}`}
              </Text>
              <Pressable
                onPress={() => extendTimer(entry.key)}
                hitSlop={8}
                accessibilityLabel="Add a minute (strip)"
                style={({ pressed }) => [s.timerPillAction, pressed && { opacity: 0.6 }]}
              >
                <Text style={s.timerPillActionText}>+1 min</Text>
              </Pressable>
              <Pressable
                onPress={() => clearTimer(entry.key)}
                hitSlop={8}
                accessibilityLabel="Dismiss timer (strip)"
                style={({ pressed }) => [s.timerPillAction, pressed && { opacity: 0.6 }]}
              >
                <Text style={s.timerPillActionText}>✕</Text>
              </Pressable>
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
                amountRefs={step.amountRefs}
                amountMultiplier={amountMultiplier}
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
      <CookFooter
        nextLabel={nextLabel}
        remainingMins={remainingMins}
        backDisabled={currentIndex <= 0}
        showAdvance={!onLast}
        onPrevStep={onPrevStep}
        onAdvance={onAdvance}
      />

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

  // progress segments → components/cooking/ProgressSegments.tsx (extracted)

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
  // ⚠️ WS9 BUG-199 — MOVED to neutral[700]. This carried a BUG-157 STAY comment
  // calling it "ambiguous, so left rather than guessed in the darkening
  // direction". THE SEPT 2 DEVICE PASS RESOLVED THE AMBIGUITY: the quiet tier
  // dies inside Cook Mode, so a dish attribution you read mid-cook is body text
  // like everything else on this screen. 3.7278:1 -> 6.2999:1 on the card.
  dishTag: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
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
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[2],
  },

  // timer chip → components/cooking/TimerChip.tsx (extracted)

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
  // Strip pill is a row when it carries the +1 / ✕ controls (#2).
  timerPillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
  },
  timerPillAction: {
    paddingHorizontal: Spacing[1],
  },
  timerPillActionText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },

  // footer → components/cooking/CookFooter.tsx (extracted)

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
