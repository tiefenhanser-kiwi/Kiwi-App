// WS7-8b Block 2 — Prep & Cook Hub presentation (PRD §13.3, design spec §2.1).
//
// Pure/presentational: takes a prebuilt HubModel + navigation callbacks and
// renders. No hooks, no data fetching — the route component (app/prep-cook.tsx)
// owns usePlan/usePlans and builds the model. This split keeps the screen
// render-testable in node:test (see __tests__/PrepCookHubView.test.ts).

import React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { DisplayTitle, resolveDisplayTitle } from "@/components/DisplayTitle";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";
import type {
  HubModel,
  PillTone,
  PrepCookHubModel,
  PromotablePlan,
} from "@/lib/cooking/hubModel";

interface Props {
  model: HubModel;
  /** "Prep the Week" lane CTA — Week Prep (Block 4; temporary stub for now). */
  onPrepWeek: () => void;
  /** A "This week's meals" row / today's-meal callout tap. */
  onSelectMeal: (mealId: string, planItemId: string) => void;
  /** Empty-state nudge: no plan this week → make one. */
  onMakePlan: () => void;
  /** Empty-state: promote an existing plan to "this week" (one tap). */
  onCookThisWeek: (planId: string) => void;
  /** Empty-state: the plan whose promote is in flight (shows a spinner). */
  promotingPlanId?: string | null;
}

// tone → chip colors. Mirrors the prep-status vocabulary in the design spec.
//
// Exported ONLY so lib/__tests__/tokens-contrast.test.ts can assert the chip's
// ACTUAL colours instead of re-stating the token values it already reads.
// ⚠️ A guard that pins literals without touching this map stays GREEN when the
// map changes — proved by a deliberate break during WS9 BUG-199, which reverted
// `bg` here and left the whole suite passing.
export const TONE_STYLE: Record<PillTone, { bg: string; fg: string }> = {
  sage: { bg: Colors.sage[100], fg: Colors.sage[700] },
  gold: { bg: Colors.gold.background, fg: Colors.gold.text },
  // WS9 BUG-157 — a DUAL site: `fg` colours the chip's <Text> (4.5:1) at :245
  // and :335 AND a Feather icon (3:1) at :241/:243. neutral[600] on this tone's
  // own neutral[200] fill measured 3.1141:1 — icon clear, text not.
  // Unlike an active/inactive pair, each tone here carries its OWN fill, so the
  // three tones stay distinguishable by hue+fill regardless of this value:
  // darkening flattens nothing. 3.1141 -> 5.2627.
  //
  // ⚠️ WS9 BUG-199 — BOTH HALVES MOVED AGAIN. Hans, on device: "the chips are
  // neutral that's slightly darker than the neutral background." Measured, he is
  // exactly right and it was two defects at once:
  //   chip fill vs the neutral[100] page   1.1203 -> 1.2763  (bg 200 -> 300)
  //   chip text vs its own fill            5.2627 -> 7.5303  (fg 700 -> 800)
  // ⚠️ THE DIAGNOSIS IS HUE, NOT LUMINANCE. sage (1.1642) and gold (1.1363) have
  // the SAME weak luminance separation from the page and Hans confirmed both
  // read fine — because they separate by HUE. This chip is the same warm neutral
  // as the page, so it has nothing to separate with and needs the luminance step
  // the hued tones get for free. That is why only this tone moves and the family
  // still reads as one.
  neutral: { bg: Colors.neutral[300], fg: Colors.neutral[800] },
};

const SAGE_SURFACE = Colors.sage[600]; // #5C7350 — locked "Prep the week" lane.
const CREAM = Palette.text.inverse; // #FBF7EF

export function PrepCookHubView({
  model,
  onPrepWeek,
  onSelectMeal,
  onMakePlan,
  onCookThisWeek,
  promotingPlanId,
}: Props) {
  if (model.kind === "empty") {
    return (
      <EmptyState
        plans={model.plans}
        onMakePlan={onMakePlan}
        onCookThisWeek={onCookThisWeek}
        promotingPlanId={promotingPlanId}
      />
    );
  }
  return (
    <Hub
      model={model}
      onPrepWeek={onPrepWeek}
      onSelectMeal={onSelectMeal}
    />
  );
}

// ── No-plan-this-week empty state ───────────────────────────────────────────
// A real, purposeful state (not a spinner): when the Hub resolves no active
// plan it offers two paths — make a fresh plan, or promote one of the user's
// existing plans to "this week" in a single tap. The promote re-resolves the
// Hub via the existing ["plans"] invalidation (no confirmation step).
function EmptyState({
  plans,
  onMakePlan,
  onCookThisWeek,
  promotingPlanId,
}: {
  plans: PromotablePlan[];
  onMakePlan: () => void;
  onCookThisWeek: (planId: string) => void;
  promotingPlanId?: string | null;
}) {
  return (
    <View style={s.bg}>
      <Header showBack title="Prep & Cook" />
      <Screen>
        <View style={s.emptyCard}>
          <View style={s.emptyIcon}>
            <Feather name="calendar" size={30} color={Colors.sage[700]} />
          </View>
          <Text style={s.emptyHeading}>
            No plan for this week{" "}
            <Text style={s.emptyHeadingItalic}>yet</Text>
          </Text>
          <Text style={s.emptyBody}>
            Prep &amp; Cook works from your active weekly plan. Build a new one,
            or cook one of your existing plans this week.
          </Text>
          <View style={s.emptyActions}>
            <Button label="Make a plan" variant="primary" onPress={onMakePlan} />
          </View>
        </View>

        {/* Promote-an-existing-plan list. Omitted entirely when the user has no
            instance plans (empty-of-instances → "Make a Plan" only). */}
        {plans.length > 0 && (
          <View style={s.yourPlans}>
            <Text style={s.sectionLabel}>Or cook one of your plans</Text>
            <View style={s.mealList}>
              {plans.map((p) => (
                <PromotePlanCard
                  key={p.id}
                  plan={p}
                  promoting={promotingPlanId === p.id}
                  disabled={
                    promotingPlanId != null && promotingPlanId !== p.id
                  }
                  onCook={() => onCookThisWeek(p.id)}
                />
              ))}
            </View>
          </View>
        )}
      </Screen>
    </View>
  );
}

// A PlanRow-style card (thumb + name + date-range meta) with a "Cook this week"
// promote button. While its own promote is in flight it shows a spinner; the
// other cards are disabled so a second tap can't race the first.
function PromotePlanCard({
  plan,
  promoting,
  disabled,
  onCook,
}: {
  plan: PromotablePlan;
  promoting: boolean;
  disabled: boolean;
  onCook: () => void;
}) {
  return (
    <View style={s.planCard}>
      {plan.thumbnailUrl ? (
        <Image source={{ uri: plan.thumbnailUrl }} style={s.planThumb} />
      ) : (
        <View style={[s.planThumb, s.thumbFallback]} />
      )}
      <View style={s.planText}>
        <DisplayTitle source={plan} variant="slim" style={s.planCardName} />
        {plan.dateRangeLabel && (
          <Text style={s.planMeta}>{plan.dateRangeLabel}</Text>
        )}
      </View>
      <Pressable
        onPress={() => {
          if (promoting || disabled) return;
          onCook();
        }}
        disabled={promoting || disabled}
        style={({ pressed }) => [
          s.cookThisWeekBtn,
          (promoting || disabled) && { opacity: 0.5 },
          pressed && { opacity: 0.7 },
        ]}
      >
        {promoting ? (
          <ActivityIndicator size="small" color={Colors.neutral[0]} />
        ) : (
          <Text style={s.cookThisWeekText}>Cook this week</Text>
        )}
      </Pressable>
    </View>
  );
}

// ── The Hub ─────────────────────────────────────────────────────────────────
function Hub({
  model,
  onPrepWeek,
  onSelectMeal,
}: {
  model: PrepCookHubModel;
  onPrepWeek: () => void;
  onSelectMeal: (mealId: string, planItemId: string) => void;
}) {
  const { indicator } = model;
  const indicatorTone = TONE_STYLE[indicator.tone];

  return (
    <View style={s.bg}>
      <Header showBack title="Prep & Cook" />
      <Screen>
        {/* Header block — plan name + tags + italic-dash subtitle. */}
        <View style={s.headerBlock}>
          <Text style={s.planName}>{model.planName}</Text>
          {model.tags.length > 0 && (
            <View style={s.tagRow}>
              {model.tags.map((t) => (
                <View key={t} style={s.tag}>
                  <Text style={s.tagText}>{t}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={s.subtitle}>{model.subtitle}</Text>
        </View>

        {/* Prep-status indicator (effective prepStatus). */}
        <View
          style={[
            s.indicator,
            { backgroundColor: indicatorTone.bg },
            indicator.isSuggestion && s.indicatorSuggestion,
          ]}
        >
          {indicator.isSuggestion ? (
            <Feather name="zap" size={15} color={indicatorTone.fg} />
          ) : (
            <Feather name="check-circle" size={15} color={indicatorTone.fg} />
          )}
          <Text style={[s.indicatorText, { color: indicatorTone.fg }]}>
            {indicator.label}
          </Text>
        </View>

        {/* Today's meal — surfaced prominently when one is assigned to today. */}
        {model.todaysMeal && (
          <Pressable
            onPress={() =>
              onSelectMeal(
                model.todaysMeal!.mealId,
                model.todaysMeal!.planItemId,
              )
            }
            style={({ pressed }) => [s.todayCard, pressed && { opacity: 0.9 }]}
          >
            <Text style={s.todayEyebrow}>Tonight</Text>
            <Text style={s.todayTitle}>
              Cook tonight&apos;s dinner: {resolveDisplayTitle(model.todaysMeal)}
            </Text>
          </Pressable>
        )}

        {/* Prep-the-week lane (the "Cook a meal" lane is now a text prompt over
            the meal list below — D-WS7-158: the action is tapping a meal row,
            so a separate CTA card was drift). */}
        <View style={s.lanes}>
          {/* Prep the week — sage surface, cream CTA. Disabled when prepped. */}
          <View style={s.prepLane}>
            <View style={s.prepLaneHead}>
              <Text style={s.prepLaneTitle}>Prep the week</Text>
              {model.prepWeekDisabled && (
                <View style={s.prepDoneBadge}>
                  <Text style={s.prepDoneBadgeText}>Prepped ✓</Text>
                </View>
              )}
            </View>
            <Text style={s.prepLaneBody}>
              Knock out chopping, marinades and make-ahead steps in one go.
            </Text>
            {/* WS9 BUG-199 §2B — the app's PRIMARY treatment, not a hand-rolled
                Pressable. Was a cream-filled block with a muted-sage label,
                which is the secondary/ghost look; Hans asked for "the same
                terracotta with white text treatment that was just applied
                elsewhere". §27.2: this is <Button variant="primary">, the same
                primitive every other CTA uses, so the terracotta and the white
                come from Palette.button.primary and cannot drift from it. */}
            <Button
              label={model.prepWeekDisabled ? "Week is prepped" : "Prep the Week"}
              variant="primary"
              disabled={model.prepWeekDisabled}
              onPress={onPrepWeek}
              style={s.prepCtaOnSage}
            />
          </View>
        </View>

        {/* Cook a meal — the lane is now a text prompt over this-week's meals;
            tapping a row launches Cook Mode (D-WS7-158). */}
        <Text style={s.laneTitle}>Cook a meal</Text>
        <Text style={s.cookPrompt}>
          Pick a meal from your plan and cook.
        </Text>
        <View style={s.mealList}>
          {model.meals.map((row) => {
            const pillTone = TONE_STYLE[row.pill.tone];
            return (
              <Pressable
                key={row.planItemId}
                onPress={() => onSelectMeal(row.mealId, row.planItemId)}
                style={({ pressed }) => [
                  s.mealRow,
                  pressed && { opacity: 0.9 },
                ]}
              >
                {row.thumbnailUrl ? (
                  <Image source={{ uri: row.thumbnailUrl }} style={s.thumb} />
                ) : (
                  <View style={[s.thumb, s.thumbFallback]} />
                )}
                <View style={s.mealText}>
                  <DisplayTitle
                    source={row}
                    variant="row"
                    style={s.mealTitle}
                  />
                  <Text style={s.mealMeta}>{row.metaLine}</Text>
                </View>
                <View style={[s.pill, { backgroundColor: pillTone.bg }]}>
                  <Text style={[s.pillText, { color: pillTone.fg }]}>
                    {row.pill.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },

  // header block
  headerBlock: { marginBottom: Spacing[4] },
  planName: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[1],
    marginTop: Spacing[2],
  },
  tag: {
    backgroundColor: Colors.neutral[200],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 2,
  },
  tagText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
  },
  subtitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[400],
    marginTop: Spacing[1],
  },

  // prep indicator
  indicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.lg,
    marginBottom: Spacing[4],
  },
  indicatorSuggestion: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
  },
  indicatorText: {
    fontSize: Typography.fontSize.sm,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },

  // today's meal
  todayCard: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.terra,
    padding: Spacing[4],
    marginBottom: Spacing[4],
    gap: Spacing[1],
  },
  todayEyebrow: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[500],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[500],
    letterSpacing: Typography.letterSpacing.wide,
  },
  todayTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },

  // lanes
  lanes: { gap: Spacing[3], marginBottom: Spacing[5] },
  laneTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  // "Cook a meal" text prompt over the meal list (replaces the old CTA card).
  cookPrompt: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
    marginBottom: Spacing[2],
  },
  prepLane: {
    backgroundColor: SAGE_SURFACE,
    borderRadius: Radius.xl,
    padding: Spacing[4],
    gap: Spacing[2],
    ...Shadow.card,
  },
  prepLaneHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  prepLaneTitle: {
    fontSize: Typography.fontSize.lg,
    color: CREAM,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  prepLaneBody: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.onSageSub,
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[1],
  },
  prepDoneBadge: {
    backgroundColor: "rgba(244, 241, 230, 0.18)",
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 2,
  },
  prepDoneBadgeText: {
    fontSize: Typography.fontSize.xs,
    color: CREAM,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  // WS9 BUG-199 §2B — replaces creamCta / creamCtaDisabled / creamCtaText, which
  // hand-rolled a button. The fill, the label colour, the radius, the padding and
  // the disabled opacity now all come from <Button variant="primary">.
  //
  // ⚠️ THIS RING IS LOAD-BEARING, NOT DECORATION. The primary fill is
  // terracotta[400] #C24F25 and this lane is sage[600] #5C7350: the button's own
  // boundary measures 1.1033:1 against the card it sits on. That is not a text
  // failure — the white label is 4.7308:1 and reads fine — it is a SHAPE failure:
  // red-on-green with no luminance step, which is precisely the pair that
  // collapses under red-green colour blindness. Without a ring the button's edge
  // would vanish for those users and only the floating white text would mark it.
  //
  // #FFFFFF is `Palette.button.primary.text` — the label and the edge are ONE
  // value, so the boundary cannot drift from the type. It reads on both sides:
  //   ring vs the sage lane       5.2197
  //   ring vs the terracotta fill 4.7308
  // Same principle the A1 tokens already apply to Cook Mode quantities, where
  // weight backs up colour "so the emphasis survives colorblindness and
  // bright-kitchen glare". Do not delete this to "clean up" the button.
  //
  // It rides `style` (a ViewStyle) rather than a new Button VARIANT because the
  // ring is specific to a primary sitting on a COLOURED surface — every other
  // primary in the app is on paper or a white card, where it would be noise.
  prepCtaOnSage: {
    borderWidth: 1,
    borderColor: Palette.button.primary.text,
  },

  // this week's meals
  // WS9 BUG-157 — STAYS at neutral[600]. A section label, named as such: the
  // exact quiet tier the ruling preserves.
  sectionLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[500],
    marginBottom: Spacing[2],
  },
  mealList: { gap: Spacing[2] },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[3],
    ...Shadow.card,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[200],
  },
  thumbFallback: { backgroundColor: Colors.sage[100] },
  mealText: { flex: 1, gap: 2 },
  mealTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  mealMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  pill: {
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 3,
  },
  pillText: {
    fontSize: Typography.fontSize.xs,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },

  // empty state
  emptyCard: {
    marginTop: Spacing[5],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[6],
    alignItems: "center",
    gap: Spacing[3],
    ...Shadow.card,
  },
  emptyIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing[1],
  },
  emptyHeading: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  emptyHeadingItalic: {
    fontStyle: "italic",
    color: Colors.terracotta[400],
    fontFamily: Typography.face.serifItalic[600],
  },
  emptyBody: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: Typography.face.sans[400],
    paddingHorizontal: Spacing[2],
  },
  emptyActions: { width: "100%", marginTop: Spacing[2] },

  // empty-state "your plans" promote list
  yourPlans: { marginTop: Spacing[5] },
  planCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[3],
    ...Shadow.card,
  },
  planThumb: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[200],
  },
  planText: { flex: 1, gap: 2 },
  planCardName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  planMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  cookThisWeekBtn: {
    backgroundColor: Colors.sage[700],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.md,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  cookThisWeekText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
