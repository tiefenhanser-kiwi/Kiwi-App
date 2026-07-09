// WS7-8b Block 4 (Build Block 2) — Week Prep screen (Screen 3) presentation.
//
// Pure/presentational: the container (components/PrepWeekScreen.tsx) owns the
// hooks (usePrepWeek/usePlan), the model build, and the local phase pointer;
// this renders one phase at a time. Kept render-only so it's testable in
// node:test (mirrors CookSessionView).
//
// LOCKED decisions rendered here:
//  • 4 server phases directly (PRD §13.4.2), NOT the design-spec "stage N of 5"
//    action-regrouping. Phase order is the server's fixed order.
//  • Option 1 destinations: the "Where each goes" rows are display-only meal/day
//    labels; ONE checkbox per STEP (keyed on the step's stepKey), never per row.
//  • Render-only this block: checkboxes reflect model `done` state. `onToggleStep`
//    is OPTIONAL — Block 3 passes it to wire checkPrepStep/uncheck; while absent
//    (this block) the checkboxes are display-only (non-interactive).

import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { CookFooter } from "@/components/cooking/CookFooter";
import { HighlightedText } from "@/components/cooking/HighlightedText";
import { ProgressSegments } from "@/components/cooking/ProgressSegments";
import { Header } from "@/components/Header";
import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";
import type { PrepWeekPhaseKey } from "@/lib/api/cooking";
import type {
  PrepPhaseVM,
  PrepStepVM,
  PrepWeekVM,
} from "@/lib/cooking/prepWeekModel";

// Static UI copy — a brief, friendly description per phase. The server phase
// carries a `title` but no description; these blurbs are presentation only and
// never drive any math/attribution.
const PHASE_BLURB: Record<PrepWeekPhaseKey, string> = {
  seasonings_dry: "Mix your dry rubs and spice blends so they're ready to grab.",
  sauces_marinades: "Whisk up sauces and get your proteins marinating.",
  produce: "Knock out all your washing and chopping in one pass.",
  proteins: "Trim and portion proteins — saved for last for food safety.",
};

const FOOTER_NOTE =
  "When you cook these later, Kiwi skips the prep you did here.";

interface Props {
  planName: string;
  vm: PrepWeekVM;
  /** Distinct meals the week's prep combines — drives the subtitle. */
  mealCount: number;
  /** Current phase pointer, 0..3 (clamped by the container). */
  phaseIndex: number;
  /** Primary "Mark all complete" (non-last): completePhase writes + advance. */
  onAdvancePhase: () => void;
  onPrevPhase: () => void;
  /**
   * BUG-020 — "Skip this Prep": a pure pointer advance, ZERO writes (unchecked
   * steps stay unchecked; the user can return). Shown on every phase EXCEPT the
   * last (no next phase there — Save & Exit covers the write-free exit).
   */
  onSkipPhase: () => void;
  /**
   * BUG-020 — "Save & Exit": ZERO writes, a quiet exit out of Prep the Week to
   * this plan's Meal Plan Detail screen (no celebratory toast). Shown on every
   * phase. Navigation target is owned by the route (container prop).
   */
  onSaveExit: () => void;
  /** Last-phase primary "Mark all complete": writes + the §7.12 payoff toast +
   *  routes out (container). */
  onFinish: () => void;
  /** The Week-Prep completion toast — shown by the container after finish. This
   *  is DISTINCT from the Cook-Mode "already prepped" (§7.12) toast copy. */
  toastVisible: boolean;
  /**
   * BUG-024 — the intermediate "Done with {fromPhase}, moving to {toPhase}" toast
   * shown when a phase auto-advances (per-step full-check or "Mark all complete").
   * Phase display names are plumbed from the VM. Null when no advance toast is up.
   * Mutually exclusive with the terminal `toastVisible` (the terminal one wins).
   */
  advanceToast?: { fromPhase: string; toPhase: string } | null;
  onExit: () => void;
  /**
   * Block 3 wires this to the completion endpoints. When omitted (this block),
   * the per-step checkbox renders display-only (non-interactive).
   */
  onToggleStep?: (stepKey: string) => void;
}

// One step's checkbox — display-only unless onToggle is supplied (Block 3).
function StepCheckbox({
  done,
  onToggle,
}: {
  done: boolean;
  onToggle?: () => void;
}) {
  const box = (
    <View style={[s.checkbox, done && s.checkboxDone]}>
      {done && <Text style={s.checkboxMark}>✓</Text>}
    </View>
  );
  if (!onToggle) return box;
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={done ? "Mark step not done" : "Mark step done"}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      {box}
    </Pressable>
  );
}

function StepCard({
  step,
  onToggleStep,
}: {
  step: PrepStepVM;
  onToggleStep?: (stepKey: string) => void;
}) {
  return (
    <View style={[s.stepCard, step.skipSuggested && s.stepCardMuted]}>
      <View style={s.stepHeader}>
        <Text style={s.stepNumber}>{step.number}</Text>
        <Text style={s.stepTitle}>{step.title}</Text>
        <StepCheckbox
          done={step.done}
          onToggle={onToggleStep ? () => onToggleStep(step.stepKey) : undefined}
        />
      </View>

      <View style={s.stepMetaRow}>
        {step.estimatedMinutes > 0 && (
          <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
        )}
        {step.skipSuggested && (
          <Text style={s.optionalTag}>optional — do it while cooking</Text>
        )}
      </View>

      {/* Quantities bold + terracotta via the shared guaranteed-reconstruct
          highlighter — qualifier text is never stripped. */}
      <HighlightedText text={step.instructions} style={s.stepInstructions} />

      {/* "combines N meals" pill — only when the step feeds more than one meal. */}
      {step.combinesCount > 1 && (
        <View style={s.combinesPill}>
          <Text style={s.combinesPillText}>
            combines {step.combinesCount} meals
          </Text>
        </View>
      )}

      {/* "Where each goes" — display-only destination labels (Option 1). */}
      {step.destinations.length > 0 && (
        <View style={s.whereCard}>
          <Text style={s.whereHeading}>Where each goes</Text>
          {step.destinations.map((d, i) => (
            <Text key={`${d.mealId}-${i}`} style={s.whereRow}>
              → {d.label}
            </Text>
          ))}
        </View>
      )}

      {step.storageNote && (
        <Text style={s.storageNote}>🧊 {step.storageNote}</Text>
      )}
    </View>
  );
}

export function PrepWeekView({
  planName,
  vm,
  mealCount,
  phaseIndex,
  onAdvancePhase,
  onPrevPhase,
  onSkipPhase,
  onSaveExit,
  onFinish,
  toastVisible,
  advanceToast,
  onExit,
  onToggleStep,
}: Props) {
  const total = vm.phases.length; // always 4
  const phase: PrepPhaseVM | undefined = vm.phases[phaseIndex];
  const onLastPhase = phaseIndex >= total - 1;
  const nextPhase = vm.phases[phaseIndex + 1];

  // BUG-020 (Hans-ruled footer) — three actions live in the footer, never in the
  // phase card. "Skip this Prep" (pure write-free advance) is hidden on the last
  // phase; "Save & Exit" (quiet write-free exit) is always present.
  const footerSecondaryActions = [
    ...(!onLastPhase ? [{ label: "Skip this Prep", onPress: onSkipPhase }] : []),
    { label: "Save & Exit", onPress: onSaveExit },
  ];

  // BUG-020 (Option B) — phases advanced past with unchecked steps render partial
  // on the progress bar. Derived client-side from the vm (PrepStepVM.done → phase
  // allDone); NO server call. A phase is partial iff not every step is done; the
  // bar only paints it partial once it's in the done band (i < currentIndex). An
  // empty phase is vacuously allDone, so a skipped empty phase stays solid sage.
  const partialIndices = vm.phases
    .map((p, i) => (p.allDone ? -1 : i))
    .filter((i) => i >= 0);

  // Minutes left in THIS phase — footer "~N min left". BUG-011: exclude
  // skipSuggested-demoted steps so this agrees with the kept-only header total.
  const phaseMins = phase
    ? phase.steps.reduce(
        (sum, st) => sum + (st.skipSuggested ? 0 : st.estimatedMinutes || 0),
        0,
      )
    : 0;

  return (
    <View style={s.bg}>
      <Header showBack title="Prep the Week" onBack={onExit} />

      {/* Plan name + italic-dash subtitle ("— N meals combined · ~N min —"). */}
      <Text style={s.planName}>{planName}</Text>
      <Text style={s.subtitle}>
        — {mealCount} {mealCount === 1 ? "meal" : "meals"} combined · ~
        {vm.totalEstimatedMinutes} min —
      </Text>

      {/* Phase indicator + the 4-phase progress bar. */}
      <Text style={s.phaseIndicator}>
        Phase {Math.min(phaseIndex + 1, total)} of {total}
      </Text>
      <ProgressSegments
        segmentCount={total}
        currentIndex={phaseIndex}
        partialIndices={partialIndices}
      />

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Current-phase card (deep sage) — name + blurb only. Per the Hans-ruled
            footer redesign, NO action button lives in this component; all actions
            (Mark all complete / Skip this Prep / Save & Exit) are in the footer. */}
        {phase && (
          <View style={s.phaseCard}>
            <Text style={s.phaseName}>{phase.title}</Text>
            <Text style={s.phaseDesc}>{PHASE_BLURB[phase.phase]}</Text>
          </View>
        )}

        {/* Numbered combined-step cards, or an empty-phase note. */}
        {phase && phase.steps.length > 0 ? (
          phase.steps.map((step) => (
            <StepCard
              key={step.stepKey}
              step={step}
              onToggleStep={onToggleStep}
            />
          ))
        ) : (
          <Text style={s.emptyPhase}>
            Nothing to prep ahead in this phase — you&apos;re all set here.
          </Text>
        )}

        <Text style={s.footerNote}>{FOOTER_NOTE}</Text>
      </ScrollView>

      {/* Footer nav (shared primitive). Primary "Mark all complete" force-completes
          the phase (writes + advance; on the last phase, writes + the §7.12 payoff
          finish). The write-free secondary actions — "Skip this Prep" (hidden on
          the last phase) and "Save & Exit" — render in the footer's secondary row. */}
      <CookFooter
        nextLabel={!onLastPhase && nextPhase ? nextPhase.title : null}
        remainingMins={phaseMins}
        backDisabled={phaseIndex <= 0}
        showAdvance
        onPrevStep={onPrevPhase}
        onAdvance={onLastPhase ? onFinish : onAdvancePhase}
        advanceLabel="Mark all complete"
        secondaryActions={footerSecondaryActions}
      />

      {/* Week-Prep completion toast — DISTINCT from the Cook-Mode "already
          prepped" (§7.12) copy. Non-blocking overlay. */}
      {toastVisible && (
        <View style={s.toast} pointerEvents="none">
          <Text style={s.toastText}>Woohoo! You just made your week easier!</Text>
        </View>
      )}

      {/* BUG-024 — intermediate advance toast. Same presentation as the terminal
          toast for consistency; the terminal toast takes precedence if both set. */}
      {advanceToast && !toastVisible && (
        <View style={s.toast} pointerEvents="none">
          <Text style={s.toastText}>
            {`Done with ${advanceToast.fromPhase}, moving to ${advanceToast.toPhase}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },

  planName: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[400],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[500],
    textAlign: "center",
    paddingBottom: Spacing[2],
  },

  phaseIndicator: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textAlign: "center",
    paddingBottom: Spacing[1],
  },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[8],
    gap: Spacing[3],
  },

  // current-phase card (deep sage)
  phaseCard: {
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.xl,
    padding: Spacing[4],
    gap: Spacing[1],
    ...Shadow.card,
  },
  phaseName: {
    fontSize: Typography.fontSize.xl,
    color: Palette.text.onSage,
    fontFamily: Typography.face.serif[600],
  },
  phaseDesc: {
    fontSize: Typography.fontSize.md,
    color: Palette.text.onSageSub,
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },

  // step card
  stepCard: {
    backgroundColor: Colors.neutral[0],
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[4],
    gap: Spacing[2],
    ...Shadow.card,
  },
  stepCardMuted: { opacity: 0.6 },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  stepNumber: {
    fontSize: Typography.fontSize.md,
    color: Colors.terracotta[400],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[700],
    minWidth: 20,
  },
  stepTitle: {
    flex: 1,
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  stepMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    flexWrap: "wrap",
  },
  stepMeta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  optionalTag: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[400],
  },
  stepInstructions: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 24,
  },

  // checkbox (display-only this block)
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: Radius.md,
    borderWidth: 2,
    borderColor: Colors.neutral[400],
    backgroundColor: Colors.neutral[0],
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxDone: {
    backgroundColor: Colors.sage[600],
    borderColor: Colors.sage[600],
  },
  checkboxMark: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[700],
  },

  // "combines N meals" pill (terracotta)
  combinesPill: {
    alignSelf: "flex-start",
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.terracotta[400],
    backgroundColor: Colors.terracotta[50],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[1],
  },
  combinesPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[500],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },

  // "Where each goes" sub-card
  whereCard: {
    backgroundColor: Colors.neutral[100],
    borderRadius: Radius.lg,
    padding: Spacing[3],
    gap: Spacing[1],
  },
  whereHeading: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  whereRow: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },

  storageNote: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
  },

  emptyPhase: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    paddingVertical: Spacing[6],
  },

  footerNote: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
    textAlign: "center",
    paddingTop: Spacing[2],
  },

  // §7.12 payoff toast — centered overlay; the layer never blocks taps.
  toast: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: Spacing[6],
  },
  toastText: {
    maxWidth: 320,
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.lg,
    paddingVertical: Spacing[5],
    paddingHorizontal: Spacing[5],
    overflow: "hidden",
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textAlign: "center",
    ...Shadow.overlay,
  },
});
