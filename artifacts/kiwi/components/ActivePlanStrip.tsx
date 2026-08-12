// WS9 L2b — active-plan / "tonight" strip (net-new, §3 · Components.activePlanStrip).
// A slim single-line replacement for the Home HeroCard: title · meta, with a
// right-aligned terracotta "Cook" text action on the tonight state.
//
// WS9-2 2c Commit 5 (D-WS9-144) — the 42px leading thumb was REMOVED. See
// resolve() below for why it never showed a photograph.
//
// Copy source (RULED): the three states survive verbatim from live code — this
// consumes the existing HeroModel (lib/home/heroState) and mirrors HeroCard's
// per-state copy. It does NOT re-derive from PRD §4.2.2 (off-disk). Routing is a
// prop (onPress → Plan Review; onCook → Cook Mode) — the strip stays dumb.
//
// Type-scale per FLAG 1 (token scale, not the mockup's raw px).

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Colors,
  Components,
  Palette,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { formatMacro } from "@/lib/format/macros";
import type { HeroModel } from "@/lib/home/heroState";
import { DisplayTitle } from "./DisplayTitle";

/**
 * WS9-2 2c Commit 6 — the strip renders the TWO populated HeroModel states.
 * `empty` is excluded at the type level: Home omits the whole this-week section
 * in that state (homeSectionOrder gates it on hasActivePlan), so an empty model
 * can never reach this component.
 */
export type ActivePlanStripModel = Exclude<HeroModel, { kind: "empty" }>;

type Props = {
  model: ActivePlanStripModel;
  /** Tap the strip → Plan Review (parent owns the route). */
  onPress?: () => void;
  /** Tonight state only — launch Cook Mode for tonight's meal (parent owns it). */
  onCook?: () => void;
};

// Mirror of HeroCard's per-state copy, folded into a single slim meta line.
//
// WS9-2 2c Commit 5 (D-WS9-144) — `thumb` is gone. The 42px slot has PROVABLY
// never rendered a photograph: the "plan" state hard-coded null, and the
// "today" state read Meal.imageUrl, which is non-null on 0 of 1471 rows. It was
// a warm-gradient square, permanently. That is exactly the ruling's logic — a
// generated MealPlanInstance surface with nothing honest to show.
function resolve(model: ActivePlanStripModel): {
  title: string;
  meta: string;
  showCook: boolean;
} {
  if (model.kind === "today") {
    const { meal } = model;
    const parts = ["Tonight"];
    if (meal.minutes) parts.push(`${meal.minutes} min`);
    if (meal.calories) parts.push(`${formatMacro(meal.calories, "0")} cal`);
    return {
      title: meal.title,
      meta: parts.join(" · "),
      showCook: true,
    };
  }
  // WS9-2 2c Commit 6 — the `empty` branch is GONE, and the prop type narrowed
  // to exclude it. It was UNREACHABLE: the strip is mounted only inside the
  // "thisWeek" section, homeSectionOrder emits that section only when
  // hasActivePlan, and hasActivePlan is exactly `heroModel.kind !== "empty"`.
  // So kind === "empty" could never arrive here — yet the branch carried
  // written, styled copy ("No plan this week yet" / "Tap to get started") that
  // read like a live empty state and would mislead the next person to touch
  // this file. Narrowing the type means the compiler now enforces what the
  // section order already guaranteed.
  const parts = ["This week"];
  if (model.durationDays) parts.push(`${model.durationDays} days`);
  return { title: model.name, meta: parts.join(" · "), showCook: false };
}

export function ActivePlanStrip({ model, onPress, onCook }: Props) {
  const { title, meta, showCook } = resolve(model);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.strip, pressed && { opacity: 0.9 }]}
    >
      <View style={styles.textCol}>
        <DisplayTitle source={title} variant="slim" style={styles.title} />
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      {showCook && onCook ? (
        <Pressable
          onPress={onCook}
          hitSlop={8}
          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.cook}>Cook</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: Components.activePlanStrip.background,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Components.activePlanStrip.radius,
    paddingVertical: 9,
    paddingHorizontal: Spacing[3],
  },
  textCol: {
    flex: 1,
  },
  title: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.serif[500],
  },
  meta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 1,
  },
  cook: {
    marginLeft: "auto",
    color: Components.activePlanStrip.cookAccent,
    fontWeight: Typography.fontWeight.bold,
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[700],
  },
});
