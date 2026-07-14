// WS9 L2b — active-plan / "tonight" strip (net-new, §3 · Components.activePlanStrip).
// A slim single-line replacement for the Home HeroCard: thumb · title · meta,
// with a right-aligned terracotta "Cook" text action on the tonight state.
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
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { formatMacro } from "@/lib/format/macros";
import type { HeroModel } from "@/lib/home/heroState";
import { TreatedImage } from "./TreatedImage";

type Props = {
  model: HeroModel;
  /** Tap the strip → Plan Review (parent owns the route). */
  onPress?: () => void;
  /** Tonight state only — launch Cook Mode for tonight's meal (parent owns it). */
  onCook?: () => void;
};

// Mirror of HeroCard's per-state copy, folded into a single slim meta line.
function resolve(model: HeroModel): {
  thumb: { uri: string } | null;
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
      thumb: meal.image ? { uri: meal.image } : null,
      title: meal.title,
      meta: parts.join(" · "),
      showCook: true,
    };
  }
  if (model.kind === "plan") {
    const parts = ["This week"];
    if (model.durationDays) parts.push(`${model.durationDays} days`);
    return { thumb: null, title: model.name, meta: parts.join(" · "), showCook: false };
  }
  return {
    thumb: null,
    title: "No plan this week yet",
    meta: "Tap to get started",
    showCook: false,
  };
}

export function ActivePlanStrip({ model, onPress, onCook }: Props) {
  const { thumb, title, meta, showCook } = resolve(model);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.strip, pressed && { opacity: 0.9 }]}
    >
      <TreatedImage
        source={thumb}
        width={Components.activePlanStrip.thumbSize}
        height={Components.activePlanStrip.thumbSize}
        radius={Radius.md}
      />
      <View style={styles.textCol}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
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
