// WS7-8b Block 4 (Build Block 3) — Week Prep screen container.
//
// Owns the data wiring for Screen 3: the generate call (usePrepWeek), the plan
// detail for destination labels (usePlan), the RESUME read (usePrepWeekComple-
// tions), the per-step completion WRITE (usePrepStepToggle), the model build,
// the LOCAL phase pointer, and the §7.12 finish toast. Renders PrepWeekView.
//
// WRITE-BACK (D-WS7-157): the per-step checkbox optimistically updates the
// resume cache and fires checkPrepStep/uncheckPrepStep; the toggle hook reverts
// on failure and invalidates ["plans"]/["meals","detail"]/["home"] + the resume
// key so the per-meal isPrepped rollup propagates to the single-meal Cook gate.
// We never write isPrepped — it's server-derived; we just write the step rows.
//
// Entitlement (PRD §13.4.6 vs. trial): a 402 resolves as a GENTLE recoverable
// "upgrade" state (never a hard paywall). The gate is inert in trial today.

import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { PrepWeekView } from "@/components/PrepWeekView";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { usePlan } from "@/hooks/usePlan";
import { usePrepWeek } from "@/hooks/usePrepWeek";
import { usePrepWeekCompletions } from "@/hooks/usePrepWeekCompletions";
import { usePrepStepToggle } from "@/hooks/usePrepStepToggle";
import {
  buildMealLabelLookup,
  buildPrepWeekModel,
} from "@/lib/cooking/prepWeekModel";

const LAST_PHASE_INDEX = 3; // 4 fixed phases, 0..3
const TOAST_MS = 2500; // PRD §7.12 — 2-3s

export function PrepWeekScreen({
  planId,
  onExit,
}: {
  planId: string;
  onExit: () => void;
}) {
  const prepQuery = usePrepWeek(planId);
  const planQuery = usePlan(planId);
  const completionsQuery = usePrepWeekCompletions(planId);
  const { toggle, completePhase } = usePrepStepToggle(planId);

  const [phaseIndex, setPhaseIndex] = useState(0);
  const [toastVisible, setToastVisible] = useState(false);
  const [writeError, setWriteError] = useState(false);

  const outcome = prepQuery.data;

  // Destination-label lookup from the plan detail (mealId → {name, day}).
  const lookup = useMemo(
    () => buildMealLabelLookup(planQuery.data?.items ?? []),
    [planQuery.data],
  );

  // Resume: the persisted checked stepKeys (server is source of truth on mount;
  // the write path setQueryData's this same cache for optimistic feedback).
  const checkedStepKeys = useMemo(
    () =>
      new Set(completionsQuery.data?.completions.map((c) => c.stepKey) ?? []),
    [completionsQuery.data],
  );

  const vm = useMemo(() => {
    if (outcome?.kind !== "ok") return null;
    return buildPrepWeekModel(outcome.envelope.result, {
      mealLabel: lookup,
      checkedStepKeys,
    });
  }, [outcome, lookup, checkedStepKeys]);

  // Distinct meals the week's prep combines (subtitle). From the server result's
  // attribution — never recomputed client-side.
  const mealCount = useMemo(() => {
    if (outcome?.kind !== "ok") return 0;
    const ids = new Set<string>();
    for (const phase of outcome.envelope.result.phases) {
      for (const step of phase.steps) {
        for (const id of step.contributesToMealIds) ids.add(id);
      }
    }
    return ids.size;
  }, [outcome]);

  // Finish toast (§7.12) → lands, then routes out.
  useEffect(() => {
    if (!toastVisible) return;
    const t = setTimeout(() => {
      setToastVisible(false);
      onExit();
    }, TOAST_MS);
    return () => clearTimeout(t);
  }, [toastVisible, onExit]);

  // Non-blocking write-error banner auto-dismiss.
  useEffect(() => {
    if (!writeError) return;
    const t = setTimeout(() => setWriteError(false), TOAST_MS);
    return () => clearTimeout(t);
  }, [writeError]);

  const prevPhase = () => setPhaseIndex((i) => Math.max(0, i - 1));

  // "Skip this phase" (skippable phases only) — a PURE pointer advance. Skipping
  // is NOT doing, so it writes nothing (distinct from "Done with phase ✓").
  const skipPhase = () =>
    setPhaseIndex((i) => Math.min(i + 1, LAST_PHASE_INDEX));

  // R1 — "Done with phase ✓" / "Finish prep ✓" assert the whole phase is done:
  // batch-check every not-yet-checked step (one optimistic write + one
  // invalidation via completePhase), THEN run `after` (advance / finish). On
  // failure we do NOT advance — stay on the phase and surface the banner so the
  // user sees the error and the true state.
  const completeCurrentPhase = (after: () => void) => {
    if (!vm) return;
    const phase = vm.phases[phaseIndex];
    if (!phase) return;
    void completePhase(phase.steps.map((st) => st.stepKey))
      .then(after)
      .catch(() => setWriteError(true));
  };

  const advancePhase = () =>
    completeCurrentPhase(() =>
      setPhaseIndex((i) => Math.min(i + 1, LAST_PHASE_INDEX)),
    );
  const finishPrep = () => completeCurrentPhase(() => setToastVisible(true));

  // Per-step write: flip vs. the current checked set; optimistic + revert live in
  // the toggle hook. A rejection surfaces a non-blocking banner (state already
  // reverted by the hook).
  const onToggleStep = (stepKey: string) => {
    const nextChecked = !checkedStepKeys.has(stepKey);
    void toggle(stepKey, nextChecked).catch(() => setWriteError(true));
  };

  // ── No plan resolved (empty planId — deep-link gap) ─────────────────────────
  if (planId.length === 0) {
    return (
      <View style={s.bg}>
        <Header showBack title="Prep the Week" onBack={onExit} />
        <View style={s.center}>
          <Text style={s.errorText}>
            We couldn&apos;t find this week&apos;s plan. Make or pick a plan first.
          </Text>
          <Button label="Back" variant="secondary" onPress={onExit} />
        </View>
      </View>
    );
  }

  // ── Loading: the AI generate call / plan / resume read in flight ────────────
  if (prepQuery.isLoading || planQuery.isLoading || completionsQuery.isLoading) {
    return (
      <View style={s.bg}>
        <Header showBack title="Prep the Week" onBack={onExit} />
        <View style={s.center}>
          <ActivityIndicator color={Colors.sage[700]} />
          <Text style={s.muted}>Kiwi is combining your week’s prep…</Text>
        </View>
      </View>
    );
  }

  // ── Error: a hard failure (404/502/401/schema) ──────────────────────────────
  if (prepQuery.isError || !outcome) {
    return (
      <View style={s.bg}>
        <Header showBack title="Prep the Week" onBack={onExit} />
        <View style={s.center}>
          <Text style={s.errorText}>
            We couldn&apos;t build your prep plan. Pull back and try again.
          </Text>
          <Button label="Back" variant="secondary" onPress={onExit} />
        </View>
      </View>
    );
  }

  // ── Upgrade required (402): gentle + recoverable, NOT a hard paywall ─────────
  if (outcome.kind === "upgrade_required") {
    return (
      <View style={s.bg}>
        <Header showBack title="Prep the Week" onBack={onExit} />
        <View style={s.center}>
          <View style={s.upgradeCard}>
            <Text style={s.upgradeHeading}>Prep the Week is a Premium feature</Text>
            <Text style={s.upgradeBody}>{outcome.message}</Text>
            <Button label="Maybe later" variant="secondary" onPress={onExit} />
          </View>
        </View>
      </View>
    );
  }

  // ── OK: render the resolved model ───────────────────────────────────────────
  if (!vm) return null; // non-null whenever outcome.kind === "ok"

  return (
    <View style={s.bg}>
      <PrepWeekView
        planName={planQuery.data?.name ?? "Your week"}
        vm={vm}
        mealCount={mealCount}
        phaseIndex={phaseIndex}
        onAdvancePhase={advancePhase}
        onPrevPhase={prevPhase}
        onSkipPhase={skipPhase} // pure pointer advance — skipping writes nothing
        onFinish={finishPrep}
        toastVisible={toastVisible}
        onExit={onExit}
        onToggleStep={onToggleStep}
      />
      {writeError && (
        <View style={s.writeErrorBanner} pointerEvents="none">
          <Text style={s.writeErrorText}>Couldn&apos;t save that — try again.</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing[3],
    paddingHorizontal: Spacing[5],
  },
  muted: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  errorText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    fontFamily: Typography.face.sans[400],
  },
  upgradeCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[5],
    gap: Spacing[3],
    alignItems: "center",
  },
  upgradeHeading: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  upgradeBody: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: Typography.face.sans[400],
  },
  // Non-blocking write-failure banner (the optimistic state is already reverted).
  writeErrorBanner: {
    position: "absolute",
    top: Spacing[2],
    left: Spacing[4],
    right: Spacing[4],
    backgroundColor: Colors.terracotta[600],
    borderRadius: Radius.lg,
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[4],
  },
  writeErrorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[0],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
    textAlign: "center",
  },
});
