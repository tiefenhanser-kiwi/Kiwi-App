// WS9 Redesign Arc Block 2a Part D (D-WS9-237) — "Pick your meals": the picks
// ARE the plan.
//
// Fed by the wizard's POST /wizard/shelf response (Part C, path A). The user
// taps cards to pick, "Get more options" pages the shelf by exclusion, and
// "Build my week" posts the picked ids (in the order picked) to
// POST /plans/from-meals, which creates ONE ACTIVE plan — no chooser, no draft,
// no AI — and lands on the plan screen the wizard's activate lands on today
// (/plan/[id]), invalidating ["plans"] + ["home"] (the BUG-051 gap) and showing
// the existing demotion toast when a previous this-week plan was displaced.
//
// The rules (rounds 4 / thin-shelf 2, exhausted, over-cap counted-not-blocked)
// live in lib/wizard/pickMeals.ts where they are tested; this file is the
// chrome and the wiring. Mounted by app/pick-meals.tsx (route name chosen to
// match the kebab-case sibling routes: wizard-results, meal-builder).
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { MealPickCard } from "@/components/MealPickCard";
import { useToast } from "@/contexts/ToastProvider";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  createPlanFromMeals,
  type CreatePlanFromMealsResponse,
} from "@/lib/api/plans";
import { buildWizardShelf, type WizardShelfResponse } from "@/lib/api/wizard";
import { demotionToastMessage } from "@/lib/plans/planLifecycleActions";
import type { WizardShelfRequest } from "@/lib/wizard/perRunPayload";
import {
  appendPage,
  excludeIdsFor,
  footerPickedLine,
  initialPickState,
  isExhausted,
  MORE_PAGE_SIZE,
  moreCaption,
  overCapPickedCount,
  pickHeaderSubline,
  SLOW_ROUND_MS,
  togglePick,
  type PickMealsParamsInput,
  type PickState,
} from "@/lib/wizard/pickMeals";

// Copy — verbatim from the locked mockups.
export const PICK_TITLE = "Pick your meals";
export const MORE_LABEL = "Get more options";
export const MORE_SLOW_CAPTION = "Kiwi is creating a few new ones…";
export const EXHAUSTED_TITLE = "Not many meals fit your preferences and restrictions.";
export const EXHAUSTED_BODY = "Refine them for this plan, or tell Kiwi what you're after.";
export const EXHAUSTED_REFINE = "Refine preferences";
export const EXHAUSTED_TELL = "Tell Kiwi";
export const BUILD_LABEL = "Build my week";
export const FOOTER_FLEX = (days: number) => `fewer or more than ${days} is fine`;
export const FOOTER_OVER_CAP = (n: number, cap: number) => ` · ${n} over your ${cap}-min cap`;
export const COULDNT_FIND = (names: string[]) => `Couldn't find: ${names.join(", ")}`;
/** The server's default title for a picks plan — mirrored so the demotion toast can name it. */
export const PICKS_PLAN_TITLE = "Your picks";

export type PickMealsScreenProps = PickMealsParamsInput;

export function PickMealsScreen({
  shelf,
  request,
  mode,
  planDurationDays,
  householdSize,
  capMinutes,
}: PickMealsScreenProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();

  const [state, setState] = useState<PickState>(() => initialPickState(shelf));

  // "Get more options" — the shelf again with every shown id excluded.
  const moreMutation = useMutation<WizardShelfResponse, Error, WizardShelfRequest>({
    mutationFn: buildWizardShelf,
  });
  // The 3 s caption: while a round is in flight longer than SLOW_ROUND_MS the
  // caption says Kiwi is creating new ones (the AI fallback lands server-side
  // later; the client is ready for it).
  const [slowRound, setSlowRound] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (moreMutation.isPending) {
      slowTimer.current = setTimeout(() => setSlowRound(true), SLOW_ROUND_MS);
    } else {
      setSlowRound(false);
    }
    return () => {
      if (slowTimer.current) {
        clearTimeout(slowTimer.current);
        slowTimer.current = null;
      }
    };
  }, [moreMutation.isPending]);

  const buildMutation = useMutation<CreatePlanFromMealsResponse, Error, string[]>({
    mutationFn: (mealIds) =>
      createPlanFromMeals({
        mealIds,
        planDurationDays,
        householdSize,
        title: PICKS_PLAN_TITLE,
      }),
  });

  const handleMore = () => {
    if (moreMutation.isPending || isExhausted(state)) return;
    moreMutation.mutate(
      { ...request, excludeMealIds: excludeIdsFor(state), size: MORE_PAGE_SIZE },
      {
        onSuccess: (page) => setState((prev) => appendPage(prev, page)),
      },
    );
  };

  const handleBuild = () => {
    if (state.pickedIds.length === 0 || buildMutation.isPending) return;
    buildMutation.mutate(state.pickedIds, {
      onSuccess: (result) => {
        // BUG-051's gap — the same invalidation the activate path does.
        queryClient.invalidateQueries({ queryKey: ["plans"] });
        queryClient.invalidateQueries({ queryKey: ["home"] });
        // D-WS9-011a — the existing demotion toast, off the response's `demoted`.
        const msg = demotionToastMessage(PICKS_PLAN_TITLE, result.demoted);
        if (msg) showToast({ message: msg });
        router.replace({
          pathname: "/plan/[id]",
          params: { id: result.instance.id },
        });
      },
    });
  };

  // The exhausted card's two exits — back into the wizard, in the mode named.
  const handleRefine = () =>
    router.push({ pathname: "/wizard", params: { adjust: "1" } });
  const handleTellKiwi = () =>
    router.push({ pathname: "/tellkiwi", params: { focus: "1" } });

  const exhausted = isExhausted(state);
  const overCapPicked = overCapPickedCount(state, capMinutes);
  const pickedCount = state.pickedIds.length;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header
        showBack
        title={PICK_TITLE}
        subtitle={pickHeaderSubline(state.totalEligible)}
      />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {mode === "text" && state.unmatchedNames.length > 0 && (
          <Text style={s.quietLine}>{COULDNT_FIND(state.unmatchedNames)}</Text>
        )}

        <View style={s.list}>
          {state.meals.map((meal) => (
            <MealPickCard
              key={meal.id}
              meal={meal}
              selected={state.pickedIds.includes(meal.id)}
              capMinutes={capMinutes}
              onToggle={() => setState((prev) => togglePick(prev, meal.id))}
            />
          ))}
        </View>

        {moreMutation.isError && (
          <View style={s.noticeCard}>
            <Text style={s.noticeTitle}>Kiwi got distracted. Try again?</Text>
            {moreMutation.error?.message ? (
              <Text style={s.noticeBody}>{moreMutation.error.message}</Text>
            ) : null}
          </View>
        )}

        {exhausted ? (
          <View style={s.exhaustedCard}>
            <Text style={s.exhaustedTitle}>{EXHAUSTED_TITLE}</Text>
            <Text style={s.exhaustedBody}>{EXHAUSTED_BODY}</Text>
            <View style={s.exhaustedRow}>
              <View style={{ flex: 1 }}>
                <Button label={EXHAUSTED_REFINE} variant="ghost" onPress={handleRefine} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label={EXHAUSTED_TELL} variant="ghost" onPress={handleTellKiwi} />
              </View>
            </View>
          </View>
        ) : (
          <View style={s.moreWrap}>
            <Pressable
              onPress={handleMore}
              disabled={moreMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={MORE_LABEL}
              style={({ pressed }) => [s.moreButton, pressed && { opacity: 0.7 }]}
            >
              {moreMutation.isPending ? (
                <ActivityIndicator color={Colors.sage[700]} />
              ) : (
                <Text style={s.moreLabel}>{MORE_LABEL}</Text>
              )}
            </Pressable>
            <Text style={s.moreCaption}>
              {moreMutation.isPending && slowRound
                ? MORE_SLOW_CAPTION
                : moreCaption(state.roundsLeft)}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Sticky footer. */}
      <View style={[s.footer, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <Text style={s.footerLine1}>{footerPickedLine(pickedCount, planDurationDays)}</Text>
        <Text style={s.footerLine2}>
          {FOOTER_FLEX(planDurationDays)}
          {overCapPicked > 0 && capMinutes !== null && (
            <Text style={s.footerOverCap}>{FOOTER_OVER_CAP(overCapPicked, capMinutes)}</Text>
          )}
        </Text>
        {buildMutation.isError && (
          <Text style={s.footerError}>
            {buildMutation.error?.message || "Couldn't build your week. Try again."}
          </Text>
        )}
        <Button
          label={BUILD_LABEL}
          variant="primary"
          onPress={handleBuild}
          disabled={pickedCount === 0}
          loading={buildMutation.isPending}
          testID="pick-build"
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[6],
    gap: Spacing[3],
  },
  quietLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  list: {
    gap: 9,
  },
  moreWrap: {
    gap: Spacing[1],
    alignItems: "center",
  },
  // A ghost, full-width, in line with the cards.
  moreButton: {
    alignSelf: "stretch",
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[600],
    backgroundColor: "transparent",
    paddingHorizontal: Spacing[4],
  },
  moreLabel: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  moreCaption: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  exhaustedCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[4],
    gap: Spacing[2],
  },
  exhaustedTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  exhaustedBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  exhaustedRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[1],
  },
  noticeCard: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[3],
  },
  noticeTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  noticeBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    gap: Spacing[2],
  },
  footerLine1: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  footerLine2: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: -4,
  },
  footerOverCap: {
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  footerError: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
});
