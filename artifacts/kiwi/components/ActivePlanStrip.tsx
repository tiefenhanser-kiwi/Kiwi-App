// WS9 L2b — the Home "this week" card (net-new, §3 · Components.activePlanStrip).
//
// WS9-2 2c Commit 7 — REBUILT from a slim strip into ONE card that carries its
// own actions. The problem it fixes: the strip and the utility-button row below
// it read as two unrelated objects, so nothing indicated that the buttons acted
// on the plan above them. The actions now live INSIDE the card.
//
// WS9-2 2e Part 4 Item 3 — REBUILT AGAIN, onto Plan Review's action panel.
// Structure is now identical on both states:
//
//   ┌──────────────────────────────────────┐
//   │  identity block  (tappable)          │   today: thumb + Tonight + meal
//   │                                      │   plan:  This week + plan name
//   │  ┌────────────────────────────────┐  │
//   │  │ [primary tint] │ Grocery List  │  │   ONE 2×2 panel, both states
//   │  │ Order Online   │ View plan     │  │
//   │  └────────────────────────────────┘  │
//   └──────────────────────────────────────┘
//
// ⚠️ THE FIRST CELL IS CONTEXTUAL AND ONLY THE FIRST CELL IS. Same slot, same
// tint, same `play` glyph; the label and destination switch by branch:
//   today → "Start Cooking" (onCook, Cook Mode for tonight's meal)
//   plan  → "Prep and Cook" (onPrepAndCook, the Prep & Cook hub for the plan)
// The remaining three are identical on both.
//
// ⚠️ THE STACKED FULL-WIDTH BUTTONS ARE GONE — all three of them. The today
// state's filled "Start cooking" and its full-bleed "View plan" footer, and the
// plan state's outlined "View plan" primary. The panel supersedes every one:
// rendering both would put "View plan" on this card twice on both states, which
// is the exact duplication 2c Commit 7's own test was written to forbid.
//
// ⚠️ 2c Commit 7 §7.5 IS REVERSED HERE, deliberately. That ruling kept Grocery
// list / Prep & Cook OFF this card on the reading that Grocery list is
// plan-level and Prep & Cook duplicated Start cooking's intent. The card is now
// explicitly a PANEL FOR THE PLAN — plan-level is what belongs on it — and the
// two are no longer siblings competing for one row but peer cells in a grid
// where the primary is distinguished by tint. The test that pinned §7.5 is
// inverted, not deleted.
//
// ⚠️ HOME'S ONLY TERRACOTTA FILL IS STILL THE TELL KIWI SEND BUTTON. The panel
// primary is a TINT (Button variant="tint"), which is not a fill. Nothing on
// this card may be filled.
//
// Routing stays a PROP on every action; the card is dumb.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "./Button";
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

// Part 4 Item 3 — the panel's cell icon size, matching Plan Review's
// PANEL_ICON_SIZE. 18 is the app's most common Feather size; the two panels are
// the same object on two screens and must not drift apart on this.
const PANEL_ICON_SIZE = 18;

type Props = {
  model: ActivePlanStripModel;
  /**
   * "View plan" → Plan Review (parent owns the route).
   *
   * ⚠️ On the PLAN state this is also the card-body tap (see onOpenMeal's note).
   * Deliberately the same prop rather than a second one: the destination is
   * identical, and a distinct prop would exist only to let a future caller send
   * two gestures with one meaning to two different screens.
   */
  onPress?: () => void;
  /** today state only — launch Cook Mode for tonight's meal (parent owns it). */
  onCook?: () => void;
  /** plan state only — the Prep & Cook hub for this plan. */
  onPrepAndCook?: () => void;
  /** The plan's grocery list. Both states. */
  onGroceryList?: () => void;
  /**
   * Grocery-list generation is the two-AI-call pipeline and takes 5–15s in the
   * wild. Threaded through so the cell can show it, exactly as Plan Review's
   * identical cell does — without it, this tap is silent for up to fifteen
   * seconds and reads as broken.
   */
  groceryLoading?: boolean;
  /** D-WS9-158 — the Order Online stub. Both states. */
  onOrderOnline?: () => void;
  /**
   * BUG-091, today state only — tapping the CARD BODY opens the plan-instance
   * meal detail for tonight's meal. The card rendered two working buttons and a
   * dead body; a card that looks like a meal and does nothing when you tap the
   * meal is the defect.
   *
   * ⚠️ Part 4 Item 3 — BUG-091 WAS ONLY HALF FIXED. The plan state's body was
   * dead to the touch too (reported on device), and Part 2's reasoning for
   * leaving it — "it has no meal to open, so its whole surface would duplicate
   * its single View plan action" — was correct only while a full-width "View
   * plan" primary sat right under it. That primary is gone. A named plan that
   * does nothing when tapped is now just a dead card, so it gets a body tap to
   * Plan Review via `onPress`.
   */
  onOpenMeal?: () => void;
};

/**
 * The 2×2 action panel. IDENTICAL on both states except the first cell's label
 * and handler, which is why it is one function and not two JSX blocks — a copy
 * per branch is how the two silently drift.
 *
 * ⚠️ Mirrors Plan Review's panel (app/plan/[id].tsx s.actionPanel / s.panelCell
 * / s.actionRow / s.actionCol) rather than extracting a shared component. The
 * two are the same TREATMENT applied to different action sets on surfaces with
 * different parents (paper vs. a white card); a shared component would have to
 * take the cells as data and would be a worse read than either call site. §27.2
 * asks whether the existing thing can be reused — here the reused thing is the
 * shared Button and its new `tint` variant, which is the part that carries the
 * design.
 */
function ActionPanel({
  primaryLabel,
  onPrimary,
  onGroceryList,
  groceryLoading,
  onOrderOnline,
  onViewPlan,
}: {
  primaryLabel: string;
  onPrimary?: () => void;
  onGroceryList?: () => void;
  groceryLoading?: boolean;
  onOrderOnline?: () => void;
  onViewPlan?: () => void;
}) {
  return (
    <View style={styles.actionPanel}>
      <View style={styles.actionRow}>
        <View style={styles.actionCol}>
          {/* The contextual cell. `play` on BOTH labels on purpose: the slot
              means "go and cook" either way, and swapping the glyph with the
              label would make the two states look like different panels. */}
          <Button
            label={primaryLabel}
            variant="tint"
            size="sm"
            iconLeft={
              <Feather
                name="play"
                size={PANEL_ICON_SIZE}
                color={Palette.button.tint.text}
              />
            }
            onPress={onPrimary}
          />
        </View>
        <View style={styles.actionCol}>
          <Button
            label="Grocery List"
            variant="secondary"
            size="sm"
            style={styles.panelCell}
            // ⚠️ NO "Generating…" label swap. Button renders EITHER the spinner
            // OR the icon+label, never both, so a swapped label is unreachable
            // while `loading` is true. (Plan Review's identical cell does carry
            // one; it is inert there for the same reason — reported, not fixed
            // here.) The spinner is the busy state, and `loading` also disables
            // the press, which is what guards the double-tap.
            loading={groceryLoading}
            iconLeft={
              <Feather
                name="list"
                size={PANEL_ICON_SIZE}
                color={Colors.terracotta[400]}
              />
            }
            onPress={onGroceryList}
          />
        </View>
      </View>
      <View style={styles.actionRow}>
        <View style={styles.actionCol}>
          <Button
            label="Order Online"
            variant="secondary"
            size="sm"
            style={styles.panelCell}
            iconLeft={
              <Feather
                name="shopping-cart"
                size={PANEL_ICON_SIZE}
                color={Colors.terracotta[400]}
              />
            }
            onPress={onOrderOnline}
          />
        </View>
        <View style={styles.actionCol}>
          <Button
            label="View plan"
            variant="secondary"
            size="sm"
            style={styles.panelCell}
            iconLeft={
              <Feather
                name="calendar"
                size={PANEL_ICON_SIZE}
                color={Colors.terracotta[400]}
              />
            }
            onPress={onViewPlan}
          />
        </View>
      </View>
    </View>
  );
}

export function ActivePlanStrip({
  model,
  onPress,
  onCook,
  onPrepAndCook,
  onGroceryList,
  groceryLoading,
  onOrderOnline,
  onOpenMeal,
}: Props) {
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
          {/* BUG-091 — the MEAL BLOCK is the tap target, not the whole card.
              The panel's cells are SIBLINGS of this Pressable, not descendants,
              so none of them can be swallowed by it — that is a structural
              guarantee rather than a bet on how RN resolves nested press
              responders. The tapped region is also exactly the region that
              looks like a meal, which is what a user aims at. */}
          <Pressable
            onPress={onOpenMeal}
            accessibilityRole="button"
            accessibilityLabel={`Open ${model.meal.title}`}
            style={({ pressed }) => [
              styles.mealRow,
              pressed && { opacity: 0.85 },
            ]}
          >
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
          </Pressable>

          <ActionPanel
            primaryLabel="Start Cooking"
            onPrimary={onCook}
            onGroceryList={onGroceryList}
            groceryLoading={groceryLoading}
            onOrderOnline={onOrderOnline}
            onViewPlan={onPress}
          />
        </View>
      </View>
    );
  }

  // ── plan state — an active plan, nothing assigned to today ────────────────
  // No image (D-WS9-144: plan imagery is removed; only the MEAL thumbnail
  // above is the exception).
  const dayCount = model.durationDays
    ? `${model.durationDays} ${model.durationDays === 1 ? "day" : "days"}`
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.body}>
        {/* Part 4 Item 3 — the plan state's identity block is a tap target too.
            Same shape as the today state's: a Pressable wrapping ONLY the
            identity, with the panel as its sibling. */}
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`Open ${model.name}`}
          style={({ pressed }) => [
            styles.planRow,
            pressed && { opacity: 0.85 },
          ]}
        >
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
        </Pressable>

        <ActionPanel
          primaryLabel="Prep and Cook"
          onPrimary={onPrepAndCook}
          onGroceryList={onGroceryList}
          groceryLoading={groceryLoading}
          onOrderOnline={onOrderOnline}
          onViewPlan={onPress}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ⚠️ Part 4 Item 3 — the full-bleed footer strip this used to clip is GONE, so
  // `overflow` and the padding-lives-on-body split no longer have a functional
  // reason. Both are KEPT as-is: the card's rounded corners still want the clip
  // if any future child paints to the edge, and moving the padding up would be
  // a pixel-identical refactor with a non-zero chance of not being one.
  card: {
    backgroundColor: Components.activePlanStrip.background,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Components.activePlanStrip.radius,
    overflow: "hidden",
  },
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
  // The plan state's identity block. A column, not a row — there is no
  // thumbnail beside it (D-WS9-144).
  planRow: {
    flexDirection: "row",
    alignItems: "center",
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

  // ── the action panel ──────────────────────────────────────────────────────
  // Part 4 Item 3 — the SAME recipe as Plan Review's s.actionPanel: sage[100]
  // fill, Radius.lg, 1px sage[200], Spacing[3] padding, Spacing[2] gap. The two
  // panels are one object on two screens and must be retuned together.
  //
  // ⚠️ It sits on a WHITE card here, not on paper. sage[100] on white is 1.24:1
  // and on paper 1.16:1 — near-identical, so the tint reads the same on both
  // screens and the cell borders carry the structure either way.
  actionPanel: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[200],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  // Per-cell border for the three unfilled cells. sage[500] = 3.29:1 against
  // the panel and 4.09:1 against the cell's own white surface; both sides clear
  // the 3:1 non-text bar, which sage[400] did not (2.19:1 outside).
  panelCell: {
    borderColor: Colors.sage[500],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  actionCol: { flex: 1 },
});
