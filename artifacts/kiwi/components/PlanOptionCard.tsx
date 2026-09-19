// WS9 Plan-flow redesign (D-WS9-191) Block 2 Part B — one plan-options card:
// a pared-back plan review the user chooses FROM (the canvas "Kiwi Plan Flow",
// board Chooser_Ruled).
//
// title (serif) · meta line ("5 dinners · serves 4 · ~40 min avg") · meal rows
// (the 60px placeholder ramp — ImageTreatment.thumbSize, D-WS9-252 — NOT the Pick screen's
// 72 — + title + the cook time when the wire carried one + a description of up
// to four lines, the row never shorter than a two-line one) · "Why this works" bullets · the daily
// macro line · the actions row: Use This Week (tint) · Save for Later (ghost) ·
// Not For Me (ghostQuiet — text2 ink). NO hero image (imageUrl / badge are dead fields on
// the candidate — Phase 0), no tags row (spec §2). The card body is not a tap
// target: the actions are the only way in.
//
// WS9 row 5 Block 4 — the meal rows render the STORE meal's image when the
// wire row carries one (`meals[].imageUrl`, composed server-side from the
// shelf row in wizardCandidateMeals.ts). This screen is entered from the
// wizard's "Complete plans" path and the previous-options link — never from
// the Pick screen — so no shelf batch is in memory to join against; the wire
// row is the only source, and no fetch is built to get a photo on a card. A
// live slot (no storeMealId) has no image and renders the ramp; so does a
// store slot whose meal the queue has not reached yet (D-WS9-253: the gradient
// is the accepted terminal state).
//
// States (lib/wizard/planOptions.ts): fresh → the three actions; busy → the
// pressed action shows its busy label and everything on every card disables;
// saved → a "Saved ✓" line where the actions row was, keeping ONLY Use This
// Week (board Chooser_AfterDismiss). A dismissed card is not rendered at all
// (the screen collapses it).

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { TreatedImage } from "@/components/TreatedImage";
import {
  Colors,
  ImageTreatment,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { formatMacro } from "@/lib/format/macros";
import type { WizardPlanCandidate } from "@/lib/types";
import {
  candidateIdentity,
  DISMISS_LABEL,
  metaLine,
  rowsFor,
  rowTimeLabel,
  SAVE_BUSY_LABEL,
  SAVE_LABEL,
  SAVED_LINE,
  USE_BUSY_LABEL,
  USE_LABEL,
  WHY_LABEL,
  type PlanOptionCardState,
} from "@/lib/wizard/planOptions";

export type PlanOptionCardBusyAction = "use" | "save";

// Block 3 Part C (Hans, device pass) — the row's type metrics, named so the
// minimum height is derived, not guessed: a row with no description is padded
// to the height of a two-line one ("some meals don't have descriptions and
// their meal rows are shorter height… it looks a little awkward"); a long
// description gets a third line ("we need a 3rd row for the text") — raised to
// FOUR by BUG-294 ("some descriptions are still cut off and we need the option
// to expand to 4 lines"). The floor (ROW_BODY_MIN_HEIGHT) is unchanged: this
// raises the ceiling only.
const ROW_TITLE_LINE_HEIGHT = 20;
const ROW_DESCRIPTION_LINE_HEIGHT = 18;
export const ROW_DESCRIPTION_MAX_LINES = 4;
const ROW_BODY_GAP = 2;
export const ROW_BODY_MIN_HEIGHT =
  ROW_TITLE_LINE_HEIGHT + ROW_BODY_GAP + 2 * ROW_DESCRIPTION_LINE_HEIGHT;

interface Props {
  candidate: WizardPlanCandidate;
  state: Exclude<PlanOptionCardState, "dismissed">;
  /** Which action is in flight on THIS card (only meaningful while busy). */
  busyAction?: PlanOptionCardBusyAction | null;
  /** True while ANOTHER card is busy — every action here disables. */
  disabled?: boolean;
  householdSize: number | null;
  onUseThisWeek: () => void;
  onSaveForLater: () => void;
  onNotForMe: () => void;
}

export function macrosLine(m: WizardPlanCandidate["dailyMacros"]): string {
  return `Avg ${formatMacro(m.calories, "0")} cal/day · ${formatMacro(m.proteinG, "0")}g P · ${formatMacro(m.carbsG, "0")}g C · ${formatMacro(m.fatG, "0")}g F`;
}

export function PlanOptionCard({
  candidate,
  state,
  busyAction = null,
  disabled = false,
  householdSize,
  onUseThisWeek,
  onSaveForLater,
  onNotForMe,
}: Props) {
  const rows = rowsFor(candidate);
  // lane-pfc Part C.5 — testIDs key on the CONTENT identity (BUG-289's
  // candidateIdentity), never candidate.id: the AI-minted id is not unique
  // across runs and was removed from every load-bearing path. Keeping it here
  // would invite the next author to trust it.
  const idKey = candidateIdentity(candidate);
  const busy = state === "busy";
  const locked = busy || disabled;
  const useLabel = busy && busyAction === "use" ? USE_BUSY_LABEL : USE_LABEL;
  const saveLabel = busy && busyAction === "save" ? SAVE_BUSY_LABEL : SAVE_LABEL;

  return (
    <View style={s.card} accessibilityLabel={candidate.title} testID={`plan-option-${idKey}`}>
      <Text style={s.title}>{candidate.title}</Text>
      <Text style={s.meta}>{metaLine(candidate, householdSize)}</Text>

      <View style={s.rows}>
        {rows.map((row, i) => (
          <View key={`${i}-${row.title}`} style={s.row}>
            <TreatedImage
              source={row.imageUrl ? { uri: row.imageUrl } : null}
              width={ImageTreatment.thumbSize}
              height={ImageTreatment.thumbSize}
              radius={Radius.md}
            />
            <View style={s.rowBody}>
              <Text style={s.rowTitle} numberOfLines={2}>
                {row.title}
              </Text>
              {rowTimeLabel(row) ? (
                <Text style={s.rowTime} testID={`plan-option-row-time-${i}`}>
                  {rowTimeLabel(row)}
                </Text>
              ) : null}
              {row.description ? (
                <Text style={s.rowDescription} numberOfLines={ROW_DESCRIPTION_MAX_LINES}>
                  {row.description}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>

      {candidate.whyBullets.length > 0 && (
        <View style={s.why}>
          <Text style={s.whyLabel}>{WHY_LABEL}</Text>
          {candidate.whyBullets.map((b, i) => (
            <View key={i} style={s.whyRow}>
              <View style={s.whyDot} />
              <Text style={s.whyText}>{b}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={s.macros} numberOfLines={1} ellipsizeMode="tail">
        {macrosLine(candidate.dailyMacros)}
      </Text>

      {state === "saved" ? (
        <View style={s.savedRow}>
          <Text style={s.savedLine} accessibilityLabel={SAVED_LINE}>
            {SAVED_LINE}
          </Text>
          <View style={{ flex: 1 }}>
            <Button
              label={USE_LABEL}
              variant="tint"
              onPress={onUseThisWeek}
              disabled={locked}
              testID={`plan-option-${idKey}-use`}
            />
          </View>
        </View>
      ) : (
        <View style={s.actions}>
          <Button
            label={useLabel}
            variant="tint"
            onPress={onUseThisWeek}
            disabled={locked}
            testID={`plan-option-${idKey}-use`}
          />
          <View style={s.quietRow}>
            <View style={{ flex: 1 }}>
              <Button
                label={saveLabel}
                variant="ghost"
                onPress={onSaveForLater}
                disabled={locked}
                testID={`plan-option-${idKey}-save`}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={DISMISS_LABEL}
                variant="ghostQuiet"
                onPress={onNotForMe}
                disabled={locked}
                testID={`plan-option-${idKey}-dismiss`}
              />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * The skeleton shown while the first `candidate` frame is in flight: a
 * card-shaped placeholder with the row geometry of the real card (60px ramp +
 * two bars), so the first real card lands without a layout jump.
 */
export function PlanOptionCardSkeleton() {
  return (
    <View style={s.card} accessibilityLabel="Kiwi is cooking up your plans" testID="plan-option-skeleton">
      <View style={[s.bar, { width: "62%", height: 22 }]} />
      <View style={[s.bar, { width: "40%", height: 14, marginTop: -Spacing[1] }]} />
      <View style={s.rows}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={s.row}>
            <TreatedImage
              source={null}
              width={ImageTreatment.thumbSize}
              height={ImageTreatment.thumbSize}
              radius={Radius.md}
            />
            <View style={s.rowBody}>
              <View style={[s.bar, { width: "55%", height: 16 }]} />
              <View style={[s.bar, { width: "85%", height: 12 }]} />
            </View>
          </View>
        ))}
      </View>
      <View style={[s.bar, { width: "100%", height: 44, borderRadius: Radius.md }]} />
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: Colors.neutral[200],
    borderRadius: Radius.sm,
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    gap: Spacing[3],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  meta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: -Spacing[2],
  },
  rows: {
    gap: Spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: ROW_BODY_GAP,
    minHeight: ROW_BODY_MIN_HEIGHT,
  },
  rowTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    lineHeight: ROW_TITLE_LINE_HEIGHT,
  },
  rowTime: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 14,
  },
  rowDescription: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: ROW_DESCRIPTION_LINE_HEIGHT,
  },
  why: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    padding: Spacing[3],
    gap: 6,
  },
  whyLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  whyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
  },
  whyDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.sage[600],
    marginTop: 7,
  },
  whyText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  macros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
  },
  actions: {
    gap: Spacing[2],
    marginTop: Spacing[1],
  },
  quietRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    marginTop: Spacing[1],
  },
  savedLine: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
