// WS9 L2b — the Home "this week" card (net-new, §3 · Components.activePlanStrip).
//
// WS9-2 2c Commit 7 — REBUILT from a slim strip into ONE card that carries its
// own actions. The problem it fixes: the strip and the utility-button row below
// it read as two unrelated objects, so nothing indicated that the buttons acted
// on the plan above them. The actions now live INSIDE the card.
//
// Structure (ruled):
//   • every action is FULL WIDTH and STACKED — no side-by-side split anywhere
//   • primary  — filled/outlined button, inset within the card's own padding
//   • secondary — a FULL-BLEED footer strip, edge to edge, separated by a
//     0.5px hairline, with no side padding of its own
//
// today state: thumbnail + "Tonight" eyebrow + meal title (largest text on the
//   card) + time/calories + the plan it came from · primary "Start cooking"
//   (filled terracotta) · footer "View plan".
// plan state: NO image · "This week" eyebrow + plan name + day count + a line
//   saying nothing is set for today · primary "View plan" (outlined terracotta)
//   · NO footer (a footer "View plan" under a "View plan" primary is the same
//   action twice).
//
// ⚠️ Grocery list / Prep & Cook are deliberately NOT here (2c Commit 7 §7.5).
// On the today state they were wrong — Grocery list is plan-level and Prep &
// Cook duplicated Start cooking's intent — and consistency carries that to the
// plan state. Prep & Cook remains reachable from Plan Review's action bar.
//
// Routing stays a PROP (onCook / onPress); the card is dumb.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Colors,
  Components,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { formatMacro } from "@/lib/format/macros";
import type { HeroModel } from "@/lib/home/heroState";
import { DisplayTitle } from "./DisplayTitle";
import { TreatedImage } from "./TreatedImage";

/**
 * WS9-2 2c Commit 6 — the card renders the TWO populated HeroModel states.
 * `empty` is excluded at the type level: Home omits the whole this-week section
 * in that state (homeSectionOrder gates it on hasActivePlan), so an empty model
 * can never reach this component.
 */
export type ActivePlanStripModel = Exclude<HeroModel, { kind: "empty" }>;

type Props = {
  model: ActivePlanStripModel;
  /** Tap the card / "View plan" → Plan Review (parent owns the route). */
  onPress?: () => void;
  /** today state only — launch Cook Mode for tonight's meal (parent owns it). */
  onCook?: () => void;
};

export function ActivePlanStrip({ model, onPress, onCook }: Props) {
  if (model.kind === "today") {
    const { meal } = model;
    const meta = [
      meal.minutes ? `${meal.minutes} min` : null,
      meal.calories ? `${formatMacro(meal.calories, "0")} cal` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <View style={styles.card}>
        <View style={styles.body}>
          <View style={styles.mealRow}>
            {/* ⚠️ WS9-2 2c Commit 7 — this call site was REMOVED in Commit 5 and
                is deliberately RESTORED here, enlarged to the meal-row
                thumbnail treatment (56 × 56, Radius.md — PlanReviewMealRow's
                values, the plan-item row). Commit 5's other removals all stand;
                a MEAL thumbnail is the explicit exception to D-WS9-144, which
                removed PLAN imagery.

                Meal.imageUrl is null on 1471/1471 rows today, so in practice
                this renders TreatedImage's warm gradient — that is the intended
                fallback, not a bug. */}
            <TreatedImage
              source={meal.image ? { uri: meal.image } : null}
              width={Components.activePlanStrip.thumbSize}
              height={Components.activePlanStrip.thumbSize}
              radius={Radius.md}
            />
            <View style={styles.textCol}>
              <Text style={styles.eyebrow}>Tonight</Text>
              {/* The meal title is the largest text on the card. */}
              <DisplayTitle
                source={meal.title}
                variant="slim"
                style={styles.title}
              />
              {meta ? <Text style={styles.meta}>{meta}</Text> : null}
              <Text style={styles.provenance} numberOfLines={1}>
                {`from ${model.planName}`}
              </Text>
            </View>
          </View>

          {/* Primary — filled terracotta, inset within the card's padding. */}
          <Pressable
            onPress={onCook}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryFilled,
              pressed && styles.primaryFilledPressed,
            ]}
          >
            <Text style={styles.primaryFilledText}>Start cooking</Text>
          </Pressable>
        </View>

        {/* Secondary — FULL-BLEED strip, no side padding, hairline separator. */}
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.footer,
            pressed && styles.footerPressed,
          ]}
        >
          <Text style={styles.footerText}>View plan</Text>
        </Pressable>
      </View>
    );
  }

  // ── plan state — an active plan, nothing assigned to today ────────────────
  // No image (D-WS9-144: plan imagery is removed; only the MEAL thumbnail
  // above is the exception). No footer strip either — the primary already IS
  // "View plan", and repeating it below would be the same action twice.
  const dayCount = model.durationDays
    ? `${model.durationDays} ${model.durationDays === 1 ? "day" : "days"}`
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.body}>
        <View style={styles.textCol}>
          <Text style={styles.eyebrow}>This week</Text>
          <DisplayTitle
            source={model.name}
            variant="slim"
            style={styles.title}
          />
          <Text style={styles.meta}>
            {dayCount
              ? `${dayCount} · nothing set for today`
              : "Nothing set for today"}
          </Text>
        </View>

        {/* Primary — OUTLINED terracotta (the today state owns the filled
            treatment; this is the quieter of the two). Full width. */}
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.primaryOutlined,
            pressed && styles.primaryOutlinedPressed,
          ]}
        >
          <Text style={styles.primaryOutlinedText}>View plan</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The card clips its own full-bleed footer, so overflow must be hidden and
  // the horizontal padding must live on `body`, NOT here.
  card: {
    backgroundColor: Components.activePlanStrip.background,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Components.activePlanStrip.radius,
    overflow: "hidden",
  },
  // Everything except the full-bleed footer sits inside this padded box.
  body: {
    paddingHorizontal: Spacing[3],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[3],
    gap: Spacing[3],
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  textCol: {
    flex: 1,
  },
  eyebrow: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: Typography.letterSpacing.wide,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  // Largest text on the card.
  title: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.serif[500],
  },
  meta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  provenance: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 1,
  },

  // ── actions ───────────────────────────────────────────────────────────────
  primaryFilled: {
    backgroundColor: Components.activePlanStrip.cookAccent,
    borderRadius: Radius.lg,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryFilledPressed: {
    opacity: 0.85,
  },
  primaryFilledText: {
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.base,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  primaryOutlined: {
    borderWidth: 1.2,
    borderColor: Components.activePlanStrip.cookAccent,
    borderRadius: Radius.lg,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryOutlinedPressed: {
    backgroundColor: Colors.terracotta[50],
  },
  primaryOutlinedText: {
    color: Components.activePlanStrip.cookAccent,
    fontSize: Typography.fontSize.base,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },

  // Full-bleed secondary. No horizontal padding — it spans the card edge to
  // edge and is separated by a hairline, not by whitespace.
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border.default,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  footerPressed: {
    backgroundColor: Colors.neutral[200],
  },
  footerText: {
    color: Colors.sage[700],
    fontSize: Typography.fontSize.base,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
