// WS9 Redesign Arc Block 2a Part D (D-WS9-237) — one Pick-screen card.
//
// thumb · name (serif) · one-line description · "{total} min total · {active}
// min active" · "{kcal} kcal · {p}g protein · {c}g carbs · {f}g fat" · tag
// pills · a select circle. Selected → sage-600 1.4px border on a sage-50
// surface. Every number is rendered AS THE SERVER SENT IT — the minutes are the
// derived columns (D-WS9-235; a null active time renders as "—"), the macros
// are per serving. The client computes nothing.
//
// Pills: cuisine · difficulty · attributes (paper surface, border) · "playlist"
// (sage-100 / sage-700, note icon) · "new to you" (the gold badge pair,
// Palette.badge.trial — the nearest existing token pair, no new hex) · "over
// your {cap}-min cap" (terracotta-50 / terracotta-600) with the total in
// terracotta bold. Over-cap is a LABEL, never a block: the card stays pickable.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { TreatedImage } from "@/components/TreatedImage";
import {
  Colors,
  ImageTreatment,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import type { ShelfMeal } from "@/lib/api/wizard";
import { formatMacro } from "@/lib/format/macros";
import { cardPills } from "@/lib/meals/cardPills";
import { isOverCap } from "@/lib/wizard/pickMeals";

export const PLAYLIST_PILL = "playlist";
export const NEW_TO_YOU_PILL = "new to you";
export function overCapPill(capMinutes: number): string {
  return `over your ${capMinutes}-min cap`;
}
export function timeLine(meal: Pick<ShelfMeal, "estimatedTimeMinutes" | "activeTimeMinutes">): string {
  const active = meal.activeTimeMinutes === null ? "—" : String(meal.activeTimeMinutes);
  return `${meal.estimatedTimeMinutes} min total · ${active} min active`;
}
export function macroLine(m: ShelfMeal["macrosPerServing"]): string {
  return `${formatMacro(m.calories, "0")} kcal · ${formatMacro(m.protein, "0")}g protein · ${formatMacro(m.carbs, "0")}g carbs · ${formatMacro(m.fat, "0")}g fat`;
}

interface Props {
  meal: ShelfMeal;
  selected: boolean;
  /** The user's cook-time cap for this run; null = no cap, no pill. */
  capMinutes: number | null;
  onToggle: () => void;
  /** Block 2c Part C — the screen-level rule (showNewToYouChips); default on. */
  showNewToYou?: boolean;
}

export function MealPickCard({
  meal,
  selected,
  capMinutes,
  onToggle,
  showNewToYou = true,
}: Props) {
  const overCap = isOverCap(meal, capMinutes);
  // Block 2c Part F (BUG-284) — de-duped: the catalog's tags repeat the
  // difficulty and a lower-cased cuisine, which collided as keys.
  const tags = cardPills(meal);

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={meal.title}
      style={({ pressed }) => [
        s.card,
        selected && s.cardSelected,
        pressed && { opacity: 0.9 },
      ]}
    >
      <TreatedImage
        source={null}
        width={THUMB}
        height={THUMB}
        radius={Radius.md}
        style={s.thumb}
      />
      <View style={s.body}>
        <Text style={s.name} numberOfLines={2}>
          {meal.title}
        </Text>
        {meal.description ? (
          <Text style={s.description} numberOfLines={1}>
            {meal.description}
          </Text>
        ) : null}
        <Text style={s.meta}>
          {overCap ? (
            <>
              <Text style={s.overCapTotal}>{meal.estimatedTimeMinutes} min total</Text>
              {` · ${meal.activeTimeMinutes === null ? "—" : meal.activeTimeMinutes} min active`}
            </>
          ) : (
            timeLine(meal)
          )}
        </Text>
        <Text style={s.meta}>{macroLine(meal.macrosPerServing)}</Text>
        <View style={s.pills}>
          {tags.map((t) => (
            <View key={t} style={s.pill}>
              <Text style={s.pillText}>{t}</Text>
            </View>
          ))}
          {meal.isPlaylist && (
            <View style={[s.pill, s.pillPlaylist]}>
              <Feather name="music" size={10} color={Colors.sage[700]} />
              <Text style={[s.pillText, s.pillPlaylistText]}>{PLAYLIST_PILL}</Text>
            </View>
          )}
          {meal.isNewToYou && showNewToYou && (
            <View style={[s.pill, s.pillNew]}>
              <Text style={[s.pillText, s.pillNewText]}>{NEW_TO_YOU_PILL}</Text>
            </View>
          )}
          {overCap && capMinutes !== null && (
            <View style={[s.pill, s.pillOverCap]}>
              <Text style={[s.pillText, s.pillOverCapText]}>{overCapPill(capMinutes)}</Text>
            </View>
          )}
        </View>
      </View>
      <View style={[s.selectCircle, selected && s.selectCircleOn]}>
        {selected && <Feather name="check" size={13} color={Colors.neutral[0]} />}
      </View>
    </Pressable>
  );
}

const THUMB = 56;

const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  cardSelected: {
    borderColor: Colors.sage[600],
    borderWidth: 1.4,
    backgroundColor: Colors.sage[50],
  },
  thumb: {
    backgroundColor: ImageTreatment.placeholder.base,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  description: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  meta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  // BUG-035 — the numeric weight MATCHES the loaded face (700 / Bold).
  overCapTotal: {
    color: Colors.terracotta[600],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[700],
  },
  pills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.full,
    backgroundColor: Colors.neutral[100],
    borderWidth: 1,
    borderColor: Colors.neutral[300],
  },
  pillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  pillPlaylist: {
    backgroundColor: Colors.sage[100],
    borderColor: Colors.sage[100],
  },
  pillPlaylistText: {
    color: Colors.sage[700],
  },
  pillNew: {
    backgroundColor: Palette.badge.trial.background,
    borderColor: Palette.badge.trial.background,
  },
  pillNewText: {
    color: Palette.badge.trial.text,
  },
  pillOverCap: {
    backgroundColor: Colors.terracotta[50],
    borderColor: Colors.terracotta[50],
  },
  pillOverCapText: {
    color: Colors.terracotta[600],
  },
  selectCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: Colors.neutral[400],
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  selectCircleOn: {
    backgroundColor: Colors.sage[600],
    borderColor: Colors.sage[600],
  },
});
