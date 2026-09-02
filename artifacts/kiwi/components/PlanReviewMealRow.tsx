import React, { useRef } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { DisplayTitle } from "@/components/DisplayTitle";
import { formatMacroLine } from "@/lib/format/macros";
import {
  DAY_SHORT,
  type DayOfWeek,
  type ReviewPlanMealRow,
} from "@/lib/types";

// BUG-104 — day-pill repeat-tap lockout. Sized to swallow a hardware/gesture
// double-fire (the observed pair was 54ms apart) while staying far below a
// deliberate re-tap: a user changing their mind about a day takes an order of
// magnitude longer than this to aim at a second pill.
export const DAY_PILL_LOCKOUT_MS = 350;

interface Props {
  row: ReviewPlanMealRow;
  planId: string;
  /** Fired when the row's "Change Meal" action button is tapped — the
   *  parent screen owns the sheet + optimistic update (PRD §8.4.2). */
  onChangeMeal?: (planItemId: string, currentMealId: string) => void;
  /** Fired when the row's "Find Similar" action is tapped — parent
   *  screen owns the sheet + optimistic update (PRD §8.4.x WS5 amend.). */
  onFindSimilar?: (
    planItemId: string,
    sourceMealId: string,
    title: string,
  ) => void;
  /** Fired when a day pill is tapped (PRD §8.3.6). null = unassign. */
  onAssignDay?: (planItemId: string, day: DayOfWeek | null) => void;
  /** Fired when the row's "Compost" action is tapped — parent owns
   *  the confirmation alert + optimistic remove (PRD §8.4.5). */
  onCompost?: (planItemId: string, title: string) => void;
  /** WS9 3c (D-WS9-032) — draft/preview mode. The row's meal has no real
   *  server id (a wizard draft), so every interactive affordance is either
   *  hidden (Cook Now + the edit action row) or routed to onReadOnlyEdit
   *  (row tap, day pills) instead of navigating to a route that would 404.
   *  Editing requires saving the plan first (point 6). */
  readOnly?: boolean;
  /** Guard invoked when a readOnly row's tappable surface is pressed. */
  onReadOnlyEdit?: () => void;
}

export function PlanReviewMealRow({
  row,
  planId,
  onChangeMeal,
  onFindSimilar,
  onAssignDay,
  onCompost,
  readOnly = false,
  onReadOnlyEdit,
}: Props) {
  const router = useRouter();

  // BUG-104 — day-pill double-fire guard.
  //
  // The pills had hitSlop={6}, no debounce and no in-flight disable. Hans's
  // device log shows two PATCHes 54ms apart from one intended tap, which is
  // one of the two candidate sources of the A→B→A write oscillation (the other
  // is transport-side and could not be settled from code — the
  // "[meal-row] day-pill tapped" console.log below is deliberately RETAINED so
  // that question stays answerable on device).
  //
  // A timestamp ref rather than an in-flight boolean: the row has no handle on
  // the write's completion (onAssignDay returns void), and a latch keyed on the
  // row catching up would WEDGE the pills permanently if the write failed and
  // rolled back to the pre-tap value. A lockout window always expires, so the
  // worst case is one ignored deliberate tap, never a dead control.
  const lastDayTapAtRef = useRef(0);

  const navigateToDetail = () => {
    router.push({
      pathname: "/meal/[id]",
      params: {
        id: row.mealId,
        planId,
        planItemId: row.planItemId,
        // WS7-7-A B5 — seed the servings stepper from the plan's override so it
        // shows the plan's value (not the meal default) on open.
        ...(row.servingsOverride != null
          ? { servingsOverride: String(row.servingsOverride) }
          : {}),
      },
    });
  };

  const onRowTap = () => {
    if (readOnly) {
      onReadOnlyEdit?.();
      return;
    }
    console.log("[meal-row] row tapped (→ Meal Detail)", {
      planItemId: row.planItemId,
      mealId: row.mealId,
    });
    navigateToDetail();
  };

  const onCookNow = () => {
    console.log("[meal-row] cook-now tapped", {
      planItemId: row.planItemId,
      mealId: row.mealId,
    });
    // WS7-8b B3 — Cook Mode launch WITH plan context: planId + planItemId let
    // the cook screen read this item's isPrepped (via usePlan) and drive the
    // prep gate without asking the user.
    router.push({
      pathname: "/cook-session",
      params: { mealId: row.mealId, planId, planItemId: row.planItemId },
    });
  };

  // Macros line — only render when at least caloriesPerServing exists.
  // Missing individual macros render as 0 to keep the line shape consistent.
  const macrosLine =
    row.caloriesPerServing !== undefined
      ? formatMacroLine(
          row.caloriesPerServing,
          row.proteinGPerServing,
          row.carbsGPerServing,
          row.fatGPerServing,
        )
      : null;

  return (
    <View style={styles.card}>
      {/* Header row: title + Cook Now button.
          Title-tap also navigates to detail; Cook Now is its own action. */}
      <View style={styles.headerRow}>
        <Pressable
          onPress={onRowTap}
          style={({ pressed }) => [
            styles.titlePressable,
            pressed && { opacity: 0.85 },
          ]}
        >
          <DisplayTitle source={row} variant="row" style={styles.title} />
        </Pressable>
        {/* Cook Now is a saved-plan action — hidden on a draft (no real meal
            id to launch Cook Mode against). */}
        {!readOnly && (
          <Pressable
            onPress={onCookNow}
            style={({ pressed }) => [
              styles.cookNowBtn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.cookNowText}>Cook Now</Text>
          </Pressable>
        )}
      </View>

      {/* Body row: thumbnail + meta + macros. Tapping body also navigates. */}
      <Pressable
        onPress={onRowTap}
        style={({ pressed }) => [styles.bodyRow, pressed && { opacity: 0.85 }]}
      >
        {row.thumbnailUrl ? (
          <Image source={{ uri: row.thumbnailUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]} />
        )}
        <View style={styles.textCol}>
          {/* WS9 BUG-153 — the one-line "what's on the plate" sub-text. Pattern
              reused verbatim from MealRow.tsx:81-85: rendered ONLY when present,
              with no empty gap and no placeholder. ⚠️ Do NOT add a fallback
              ("no description available", first line of the steps, …) — 61% of
              live meals have none because the wizard writer does not populate
              it (BUG-156), and a fallback would hide that on device. */}
          {/* WS9 BUG-158 — TWO lines here, and that is a DELIBERATE DIVERGENCE
              from MealRow.tsx:82, which stays at one. Reusing MealRow's
              structure and token was right and still holds; line count is a
              per-surface decision, not part of the shared pattern. At one line
              a description clipped mid-word ("…sliced thin in warm tortill…")
              on a row whose job is helping you pick the meal. Noted here rather
              than forking the component. ⚠️ Do NOT "restore" this to 1 for
              consistency with MealRow — the divergence is the ruling. */}
          {row.description ? (
            <Text style={styles.description} numberOfLines={2}>
              {row.description}
            </Text>
          ) : null}
          <Text style={styles.metaLine}>{row.metaLine}</Text>
          {macrosLine && <Text style={styles.macros}>{macrosLine}</Text>}
        </View>
      </Pressable>

      {/* Day strip — Sun-Sat, single tap assigns; tap of currently-assigned unassigns. */}
      <View style={styles.dayStrip}>
        {row.dayStrip.map((entry) => (
          <Pressable
            key={entry.day}
            onPress={() => {
              if (readOnly) {
                onReadOnlyEdit?.();
                return;
              }
              console.log("[meal-row] day-pill tapped", {
                planItemId: row.planItemId,
                day: entry.day,
              });
              // BUG-104 — swallow a repeat inside the lockout window. Logged
              // ABOVE this check on purpose: the console line must record every
              // real tap event so the device test can still distinguish "the UI
              // fired twice" from "the transport sent twice".
              const now = Date.now();
              if (now - lastDayTapAtRef.current < DAY_PILL_LOCKOUT_MS) {
                console.log("[meal-row] day-pill tap ignored (lockout)", {
                  planItemId: row.planItemId,
                  day: entry.day,
                });
                return;
              }
              lastDayTapAtRef.current = now;
              const currentlyAssigned = row.dayStrip.find((d) => d.isAssigned);
              const next: DayOfWeek | null =
                currentlyAssigned?.day === entry.day ? null : entry.day;
              onAssignDay?.(row.planItemId, next);
            }}
            hitSlop={6}
            style={({ pressed }) => [
              styles.dayPill,
              entry.isAssigned ? styles.dayPillOn : styles.dayPillOff,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={
                entry.isAssigned ? styles.dayPillTextOn : styles.dayPillTextOff
              }
            >
              {DAY_SHORT[entry.day]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Action buttons — R2 shape: 4 actions + card-body View (D-WS9-018).
          Change Recipe removed (R-3d-2); Compost relabeled "Remove from plan"
          (R-3d-3, still a soft-delete via onCompost). The prop interface is
          unchanged — swap targets are repointed by 3d, the Edit target by 3f
          (see handoff TODOs). No 5-action rows survive Layer 2 (§3).
          WS9 3c (D-WS9-032) — hidden entirely on a draft: these are all edits,
          gated behind saving (the Add Meals button + row/day taps surface the
          guard). */}
      {!readOnly && (
      <View style={styles.actionRow}>
        <Pressable
          onPress={() => {
            console.log("[meal-row] edit tapped", {
              planItemId: row.planItemId,
              mealId: row.mealId,
            });
            // WS9 BUG-180 — Edit reaches the meal EDIT surface. It used to call
            // navigateToDetail(), i.e. the identical push a card-body tap makes,
            // so the button labelled Edit opened a read view and duplicated the
            // control next to it.
            //
            // meal-builder in PLAN CONTEXT is that surface, and it already
            // exists: passing mealId + planId + planItemId sets
            // isEditFromPlanContext, which drives the PRD §2.5 edit-from-plan
            // vs. global-save prompt. This is the same push meal/[id].tsx's own
            // onEdit makes; the two edit affordances now agree.
            //
            // ⚠️ The param is `mealId`, NOT `id`. meal/[id].tsx reads `id` from
            // its route; meal-builder reads `mealId` from useLocalSearchParams,
            // and an `id` here would silently land in fresh-create mode.
            //
            // TODO(3f): D-WS9-004's plan-scoped ingredient editor ("just this
            // time", MealPlanItem-level) is still 3f's work. When it lands it
            // replaces this destination; until then Edit correctly opens the
            // meal editor rather than the meal viewer.
            router.push({
              pathname: "/meal-builder",
              params: {
                mealId: row.mealId,
                planId,
                planItemId: row.planItemId,
              },
            });
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Edit</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] swap-different tapped", {
              planItemId: row.planItemId,
            });
            // WS9 3d Part 4 (D-WS9-018) — opens the merged SwapMealSheet in
            // "different" mode via onChangeMeal (the screen maps the callback to
            // setSwapForRow({ mode: "different" })).
            onChangeMeal?.(row.planItemId, row.mealId);
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Swap for Different Meal</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] swap-similar tapped", {
              planItemId: row.planItemId,
              mealId: row.mealId,
            });
            // WS9 3d Part 4 (D-WS9-018) — opens the merged SwapMealSheet in
            // "similar" mode via onFindSimilar (the screen maps the callback to
            // setSwapForRow({ mode: "similar" })).
            onFindSimilar?.(row.planItemId, row.mealId, row.title);
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Swap for Similar Meal</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] remove tapped", {
              planItemId: row.planItemId,
            });
            onCompost?.(row.planItemId, row.title);
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Remove from plan</Text>
        </Pressable>
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    padding: Spacing[3],
    marginBottom: Spacing[2],
    ...Shadow.card,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  titlePressable: {
    flex: 1,
  },
  bodyRow: {
    flexDirection: "row",
    gap: Spacing[3],
    alignItems: "center",
    marginTop: Spacing[2],
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: Colors.sage[100],
  },
  textCol: {
    flex: 1,
    gap: Spacing[1],
  },
  title: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  // WS9 BUG-153 — mirrors MealRow.tsx's `description` style exactly.
  // ✅ BUG-157 SWEPT IT. This comment used to read "neutral[600] is #8A8474 =
  // 3.7278:1 on the white card, BELOW the 4.5:1 AA threshold … THIS IS ONE OF
  // THE SITES TO MOVE." It moved: neutral[700] #6B5E4D = 6.2999:1 on the card.
  // MealRow.tsx's `description` moved with it, so the two are still identical
  // and the mirror above still holds.
  description: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  metaLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  macros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  cookNowBtn: {
    backgroundColor: Colors.sage[700],
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
    borderRadius: Radius.md,
  },
  cookNowText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  dayStrip: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing[2],
  },
  dayPill: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dayPillOn: {
    backgroundColor: Colors.sage[700],
  },
  dayPillOff: {
    backgroundColor: Colors.neutral[100],
  },
  dayPillTextOn: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  dayPillTextOff: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[1],
    marginTop: Spacing[2],
  },
  actionBtn: {
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
  },
  actionText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
