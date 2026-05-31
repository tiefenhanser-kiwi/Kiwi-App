// WS7-5b-mobile Block A — Plan Details screen for the two-step wizard.
//
// Reached from wizard-results.tsx after a successful POST /wizard/expand.
// Renders the expanded plan (meals, dishes, per-dish macros, ingredients,
// steps) from the params payload and exposes the two CTAs that drive the
// save / activate decision:
//
//   - "Save for Later"  → POST /wizard/drafts/:draftId/save  → 201
//       { instance: { id, revisionId } }. Stays on this screen (Hans's
//       ruling: keeping it, not committing to cook it this week). The save
//       button repurposes to a saved-state badge so it cannot be re-tapped
//       into a 404 (server returns 404 for the second save on a saved
//       draft via the shared `!isWizardDraft` guard).
//
//   - "Save and Use"    → BEFORE save: POST /wizard/drafts/:draftId/activate
//                         AFTER save:  PATCH /plans/:savedPlanId
//                                         { isActiveThisWeek: true }
//     On success: invalidate ["plans"] and router.replace to /plan/[id]
//     using the new real plan id.
//
// The post-save flip is load-bearing — once /save has fired, calling
// /activate on the same draft id returns 404 because the draft no longer
// exists as a draft. The decider helper at lib/plans/wizardPostSaveCta.ts
// owns that decision; the load-bearing PATCH path is pinned by a unit test.

import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { WizardPlanMealCard } from "@/components/WizardPlanMealCard";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  activateWizardDraft,
  saveWizardDraft,
  WizardExpandedPlanSchema,
  type WizardExpandedPlan,
} from "@/lib/api/wizard";
import { patchPlan } from "@/lib/api/plans";
import { decidePlanDetailsCta } from "@/lib/plans/wizardPostSaveCta";

function parseExpanded(raw: string | undefined): WizardExpandedPlan | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    const parsed = WizardExpandedPlanSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Plan-level daily averages derived from the per-dish macros nested in the
// expanded payload. Skips dishes whose macros failed (failed:true) and dishes
// missing macros entirely so the average reflects only data we trust. Divides
// by meals.length (the wizard's "per day" denominator — one meal = one day).
function deriveDailyAverages(plan: WizardExpandedPlan): {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
} | null {
  if (plan.meals.length === 0) return null;
  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalF = 0;
  for (const meal of plan.meals) {
    for (const dish of meal.dishes) {
      if (!dish.macros || dish.macros.failed) continue;
      totalCal += dish.macros.caloriesPerServing;
      totalP += dish.macros.proteinGPerServing;
      totalC += dish.macros.carbsGPerServing;
      totalF += dish.macros.fatGPerServing;
    }
  }
  const days = plan.meals.length;
  return {
    calories: Math.round(totalCal / days),
    proteinG: Math.round(totalP / days),
    carbsG: Math.round(totalC / days),
    fatG: Math.round(totalF / days),
  };
}

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };
type UseState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

export default function WizardPlanDetailsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { draftId, expanded } = useLocalSearchParams<{
    draftId?: string;
    expanded?: string;
  }>();

  const plan = useMemo(() => parseExpanded(expanded), [expanded]);
  const dailyAverages = useMemo(
    () => (plan ? deriveDailyAverages(plan) : null),
    [plan],
  );

  // null pre-save; the new plan id post-save. Drives the CTA decider — the
  // load-bearing flip that makes "Save and Use" target PATCH /plans instead
  // of the dead /wizard/drafts/:id/activate endpoint after save succeeds.
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [useState_, setUseState] = useState<UseState>({ kind: "idle" });

  const cta = decidePlanDetailsCta(savedPlanId);

  const handleHeaderBack = () => {
    router.back();
  };

  const handleSaveForLater = async () => {
    if (!draftId) return;
    if (saveState.kind === "pending") return;
    if (savedPlanId !== null) return; // already saved; button is disabled
    setSaveState({ kind: "pending" });
    try {
      const result = await saveWizardDraft(draftId);
      setSavedPlanId(result.instance.id);
      setSaveState({ kind: "idle" });
      // The save promotes the draft into the user's My Plans list — refresh
      // the plans-list cache so the new row shows up on next visit.
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      // Hans's ruling: stay on this screen after save (Save-for-Later semantic
      // is "keeping it, not committing to cook it this week"). The save
      // button itself flips to its saved-state badge via the decider.
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save this plan.";
      setSaveState({ kind: "error", message });
    }
  };

  const handleSaveAndUse = async () => {
    if (useState_.kind === "pending") return;
    setUseState({ kind: "pending" });

    try {
      let activatedPlanId: string;
      if (cta.useTarget.kind === "draft-activate") {
        // Pre-save: the draft id is still valid. Activate materializes +
        // demotes prior actives + auto-dates Sun-Sat (PRE).
        if (!draftId) {
          setUseState({
            kind: "error",
            message: "Missing draft id — go back to results and pick again.",
          });
          return;
        }
        const result = await activateWizardDraft(draftId);
        activatedPlanId = result.instance.id;
      } else {
        // Post-save: the draft id is dead (saved-then-activate would 404).
        // PATCH /plans/:savedPlanId { isActiveThisWeek: true } — server
        // auto-dates via PRE on this flip and demotes prior actives.
        const result = await patchPlan(cta.useTarget.planId, {
          isActiveThisWeek: true,
        });
        activatedPlanId = result.instance.id;
      }

      setUseState({ kind: "idle" });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      // Use replace so back-pop from Plan Review returns to the wizard's
      // entry point (wizard input / tellkiwi), not the now-stale Plan
      // Details screen for a draft that no longer exists.
      router.replace({
        pathname: "/plan/[id]",
        params: { id: activatedPlanId },
      });
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't activate this plan.";
      setUseState({ kind: "error", message });
    }
  };

  // ── render branches ────────────────────────────────────────────────

  if (!plan || !draftId) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack onBack={handleHeaderBack} title="Plan Details" />
        <Screen>
          <View style={s.errorBox}>
            <Text style={s.errorTitle}>
              Kiwi got distracted. Try again?
            </Text>
            <Text style={s.errorBody}>
              Plan details weren't passed through. Head back to results and
              tap "View Plan Details" again.
            </Text>
            <View style={{ marginTop: KSpacing.md }}>
              <Button
                label="Back to results"
                variant="primary"
                onPress={handleHeaderBack}
              />
            </View>
          </View>
        </Screen>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack onBack={handleHeaderBack} title="Plan Details" />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Title + tags + why bullets carried over from the candidate card. */}
        <Text style={s.planTitle}>{plan.title}</Text>
        {plan.tags.length > 0 && (
          <View style={s.tagRow}>
            {plan.tags.map((tag) => (
              <View key={tag} style={s.tag}>
                <Text style={s.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}
        {plan.whyBullets.length > 0 && (
          <View style={s.whyBox}>
            <Text style={s.whyLabel}>WHY THIS WORKS</Text>
            {plan.whyBullets.map((b, i) => (
              <View key={i} style={s.whyRow}>
                <View style={s.whyDot} />
                <Text style={s.whyText}>{b}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Plan-level daily averages, summed from per-dish macros. */}
        {dailyAverages && (
          <View style={s.macrosCard}>
            <Text style={s.sectionLabel}>Daily averages</Text>
            <View style={s.macrosGrid}>
              <MacroCell value={dailyAverages.calories} label="cal/day" />
              <MacroCell value={dailyAverages.proteinG} label="g protein" />
              <MacroCell value={dailyAverages.carbsG} label="g carbs" />
              <MacroCell value={dailyAverages.fatG} label="g fat" />
            </View>
          </View>
        )}

        {/* WS7-5c Block B — one collapsible card per meal. Default state is
            collapsed (header-only summary) so a 5-day plan doesn't render a
            wall of text before the user has decided to keep it. Tap to
            expand → ingredients + per-dish macros (no steps; see Block A). */}
        {plan.meals.map((meal, i) => (
          <WizardPlanMealCard
            key={`${meal.title}-${i}`}
            meal={meal}
            index={i}
          />
        ))}

        {/* CTAs at the bottom. Decider drives the labels + use-button target.
            The save button switches to a saved-state badge after save so the
            user can't re-tap into a 404. */}
        <View style={s.ctaWrap}>
          {saveState.kind === "error" && (
            <Text style={s.ctaError}>{saveState.message}</Text>
          )}
          {useState_.kind === "error" && (
            <Text style={s.ctaError}>{useState_.message}</Text>
          )}
          {cta.saveButton.saved ? (
            <View style={s.savedBadge}>
              <Feather name="check" size={16} color={KColors.sage[700]} />
              <Text style={s.savedBadgeText}>{cta.saveButton.label}</Text>
            </View>
          ) : (
            <Button
              label={
                saveState.kind === "pending"
                  ? "Saving…"
                  : cta.saveButton.label
              }
              variant="ghost"
              onPress={handleSaveForLater}
              loading={saveState.kind === "pending"}
              disabled={
                saveState.kind === "pending" || useState_.kind === "pending"
              }
            />
          )}
          <Button
            label={
              useState_.kind === "pending"
                ? cta.useTarget.kind === "draft-activate"
                  ? "Activating…"
                  : "Updating…"
                : cta.useButton.label
            }
            variant="primary"
            onPress={handleSaveAndUse}
            loading={useState_.kind === "pending"}
            disabled={
              saveState.kind === "pending" || useState_.kind === "pending"
            }
          />
        </View>
      </ScrollView>
    </View>
  );
}

// ── small render helpers ───────────────────────────────────────────

function MacroCell({ value, label }: { value: number; label: string }) {
  return (
    <View style={s.macroCell}>
      <Text style={s.macroValue}>{value}</Text>
      <Text style={s.macroLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
    gap: KSpacing.md,
  },
  errorBox: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
  },
  errorTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  errorBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  planTitle: {
    fontSize: KType.size.xxl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  tag: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 3,
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.pill,
  },
  tagText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  whyBox: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    gap: 6,
  },
  whyLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  whyRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "flex-start",
  },
  whyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: KColors.terracotta[400],
    marginTop: 7,
  },
  whyText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
  },
  macrosCard: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    gap: KSpacing.sm,
  },
  sectionLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  macrosGrid: {
    flexDirection: "row",
    gap: KSpacing.xs,
  },
  macroCell: {
    flex: 1,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    paddingVertical: KSpacing.sm,
    alignItems: "center",
  },
  macroValue: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  macroLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    textAlign: "center",
  },
  ctaWrap: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
  },
  ctaError: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[600],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  savedBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.md,
    paddingVertical: KSpacing.md,
  },
  savedBadgeText: {
    fontSize: KType.size.md,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
