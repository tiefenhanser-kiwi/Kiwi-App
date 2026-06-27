// WS7-8b Block 4 (Build Block 2) — Week Prep screen container.
//
// Owns the data wiring for Screen 3: the generate call (usePrepWeek), the plan
// detail for destination labels (usePlan), the model build, and the LOCAL phase
// pointer. Renders PrepWeekView once everything resolves. Render-only this block:
// NO write-back, NO completion calls — the phase pointer is pure local UI state,
// and the View's per-step checkboxes are display-only (no onToggleStep passed).
//
// NOT routed here. Block 3 swaps app/cook-session.tsx's `mode === "prep-week"`
// stub to mount `<PrepWeekScreen planId=… onExit=… />` (and supply the planId,
// which the Hub handoff does not currently pass — see the Phase 3 report).
//
// Entitlement posture (PRD §13.4.6 vs. trial): generation is premium-gated, but
// the gate is inert in trial (can() stub → allowed:true). A 402 resolves as a
// GENTLE, recoverable "upgrade" state (not a hard paywall, never blocks back-out)
// so the trial flow is never blocked.

import React, { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { PrepWeekView } from "@/components/PrepWeekView";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { usePlan } from "@/hooks/usePlan";
import { usePrepWeek } from "@/hooks/usePrepWeek";
import {
  buildMealLabelLookup,
  buildPrepWeekModel,
} from "@/lib/cooking/prepWeekModel";

const LAST_PHASE_INDEX = 3; // 4 fixed phases, 0..3

export function PrepWeekScreen({
  planId,
  onExit,
}: {
  planId: string;
  onExit: () => void;
}) {
  const prepQuery = usePrepWeek(planId);
  const planQuery = usePlan(planId);
  const [phaseIndex, setPhaseIndex] = useState(0);

  const outcome = prepQuery.data;

  // Destination-label lookup from the plan detail (mealId → {name, day}). Empty
  // until the plan resolves → labels fall back gracefully (composer handles it).
  const lookup = useMemo(
    () => buildMealLabelLookup(planQuery.data?.items ?? []),
    [planQuery.data],
  );

  const vm = useMemo(() => {
    if (outcome?.kind !== "ok") return null;
    return buildPrepWeekModel(outcome.envelope.result, { mealLabel: lookup });
  }, [outcome, lookup]);

  // Distinct meals the week's prep combines (subtitle). Derived from the server
  // result's attribution — never recomputed client-side.
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

  const advancePhase = () =>
    setPhaseIndex((i) => Math.min(i + 1, LAST_PHASE_INDEX));
  const prevPhase = () => setPhaseIndex((i) => Math.max(0, i - 1));

  // ── Loading: the AI generate call (or the plan detail) in flight ────────────
  if (prepQuery.isLoading || planQuery.isLoading) {
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
  // vm is non-null whenever outcome.kind === "ok".
  if (!vm) return null;

  return (
    <PrepWeekView
      planName={planQuery.data?.name ?? "Your week"}
      vm={vm}
      mealCount={mealCount}
      phaseIndex={phaseIndex}
      onAdvancePhase={advancePhase}
      onPrevPhase={prevPhase}
      onSkipPhase={advancePhase} // skip advances the local pointer (no server write)
      onExit={onExit}
      // onToggleStep intentionally omitted — display-only this block (Block 3 wires).
    />
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
});
