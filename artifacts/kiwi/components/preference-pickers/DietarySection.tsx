// WS9 D-WS9-206 / D-WS9-207 — the shared dietary block.
//
// WHAT WAS ACTUALLY WRONG (measured, not assumed). All four screens that ask
// about diet — preferences.tsx, onboarding-prefs.tsx, wizard.tsx, tellkiwi.tsx
// — already imported ONE <AllergiesPicker> over ONE chip list (domain.ts
// ALLERGIES_AND_AVOIDANCES). Nothing was reimplemented. What WAS duplicated is
// everything around it: the sub-labels, the "Anything else?" TextInput, and its
// styles, hand-rolled inline in each screen file. wizard.tsx and tellkiwi.tsx
// were near-clones differing only in placeholder text.
//
// The cost of that duplication, on the record:
//   - BUG-196 moved the "Allergies & avoidances" heading INTO AllergiesPicker
//     (as its ExpandLink label) and deleted the now-orphan <SubLabel> in
//     preferences.tsx ONLY. The other three screens kept their hand-rolled
//     <Text> heading, so three screens shipped the heading TWICE — once as a
//     stray label, once as the expander right below it. One fix, three
//     regressions. Those three <Text> headings are deleted with this component.
//   - BUG-154's placeholder-contrast decision landed on preferences.tsx only.
//   - tellkiwi.tsx's placeholder drifted to "no shellfish" / "low sodium".
//
// So this is an EXTRACTION of the chrome, not a consolidation of the control.
//
// ⚠️ WHAT THIS COMPONENT DOES NOT OWN: the <Section> wrapper, the section
// title, and the screen's section ORDER. Preferences has 8 sections and
// onboarding 5, both wrapping this in <Section title="Dietary preferences">;
// wizard and tellkiwi have NO section title here at all — this block sits
// inside their collapsible "Adjust..." card, under the subtitle "Optional —
// changes apply to this plan only". A shared title would have printed a
// heading on two screens that deliberately do not have one, and would have
// made the per-run screens read as persistent. The screens keep their own
// wrapper; this owns the block's internals.

import React from "react";
import { Keyboard, StyleSheet, Text, TextInput, View } from "react-native";

import { AllergiesPicker } from "./AllergiesPicker";
import { EatingStylesPicker } from "./EatingStylesPicker";
import { CustomChipInput } from "./shared";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

/**
 * ⚠️ SHIP GATE — D-WS9-206's new free-text "other allergies" field is BUILT
 * (column, PATCH allow-list, read schema, shared slot, per-run clearing) but
 * DOES NOT RENDER.
 *
 * The reason is not caution about the UI, it is the promise the label makes.
 * Retrieval filters on `Meal.allergens`; free text has no canonical token, so
 * a term typed into this box is stored and then ignored by every downstream
 * filter. Hans's own use case for the field is a GUEST who cannot eat
 * something — which is precisely the case where a silently-dropped term does
 * the most harm, not an exception to it. A label promising allergy enforcement
 * must not appear before something honours it.
 *
 * Flipping this to `true` renders the field on all four screens. It is NOT the
 * only step: the per-run value still has to reach plan generation (the wizard
 * and tellkiwi generation payloads are api-server schemas this block did not
 * touch), and the honouring mechanism is the parallel allergen-stamping lane.
 * See the Phase 3 report for the exact remaining wiring.
 */
export const OTHER_ALLERGIES_FIELD_ENABLED: boolean = false;

/** The dietary free-text placeholder, D-WS9-206's split applied.
 *
 *  ⚠️ tellkiwi.tsx used to read "no shellfish" / "low sodium" here. Under the
 *  split that example is not merely inconsistent, it is CONTENT-WRONG:
 *  shellfish is an allergy, so it now points at the wrong box. Hans's examples
 *  for the preference field are used instead. */
export const DIETARY_NOTES_PLACEHOLDER =
  "e.g., 'no cilantro', 'no veal', 'no soft cheese'";

export interface DietarySectionProps {
  eatingStyles: string[];
  onEatingStylesChange: (next: string[]) => void;
  allergies: string[];
  onAllergiesChange: (next: string[]) => void;
  /** D-WS9-206's new field. Dark until OTHER_ALLERGIES_FIELD_ENABLED flips. */
  otherAllergies: string[];
  onOtherAllergiesChange: (next: string[]) => void;
  /** "" is the blank value on every screen — see the note on the handler. */
  dietaryNotes: string;
  onDietaryNotesChange: (next: string) => void;
}

export function DietarySection({
  eatingStyles,
  onEatingStylesChange,
  allergies,
  onAllergiesChange,
  otherAllergies,
  onOtherAllergiesChange,
  dietaryNotes,
  onDietaryNotesChange,
}: DietarySectionProps) {
  const toggleOther = (item: string) => {
    onOtherAllergiesChange(
      otherAllergies.includes(item)
        ? otherAllergies.filter((i) => i !== item)
        : [...otherAllergies, item],
    );
  };

  const addOther = (item: string) => {
    if (otherAllergies.includes(item)) return;
    onOtherAllergiesChange([...otherAllergies, item]);
  };

  return (
    <View>
      <Text style={s.subLabel}>Eating styles</Text>
      <EatingStylesPicker value={eatingStyles} onChange={onEatingStylesChange} />

      {/* ⚠️ NO <Text> HEADING HERE. AllergiesPicker's own ExpandLink carries the
          label "Allergies & avoidances" (BUG-196). The three screens that still
          printed a heading above it were rendering the section title twice. */}
      <AllergiesPicker
        style={{ marginTop: Spacing[4] }}
        value={allergies}
        onChange={onAllergiesChange}
      />

      {/* D-WS9-206 — the new other-allergies field. Placement is Hans's: INSIDE
          the allergies group, below the chips, above "Anything else?". It is
          rendered flat rather than nested inside AllergiesPicker's expander so
          that the picker stays a pure chip control with one job; the visual
          grouping comes from the tighter marginTop. Dark for now. */}
      {OTHER_ALLERGIES_FIELD_ENABLED && (
        <View style={s.otherAllergies}>
          <Text style={s.subLabel}>Any other allergies?</Text>
          <Text style={s.helpText}>
            Anything Kiwi should keep out of your meals entirely.
          </Text>
          <CustomChipInput
            chips={otherAllergies}
            value={otherAllergies}
            onToggle={toggleOther}
            onAdd={addOther}
            placeholder="e.g., 'kiwi', 'cinnamon', 'pork'"
            // BUG-154's measured value (6.2999:1 on the white card), applied to
            // every dietary free-text field rather than to preferences.tsx
            // alone. ⚠️ The other three screens were NOT failing AA before this
            // — they read Palette.text.placeholder (#776D5D, 5.0849:1), not
            // neutral[600]. This converges two passing values onto the one Hans
            // signed off on; it is a consistency fix, not an a11y fix.
            placeholderTextColor={Colors.neutral[700]}
            addAccessibilityLabel="Add this allergy"
          />
        </View>
      )}

      {/* D-WS9-206 — "Anything else?" is now explicitly the PREFERENCE half of
          the split. Hans: "'Anything else' could mean 'any other notes about
          what and how you like to eat?' or it could, being directly below
          allergies & avoidances, mean 'what other allergies and avoidances
          should Kiwi honor?'" The helper line names which one it is.

          ⚠️ NO "(Optional)" BADGE, and it is REMOVED from onboarding-prefs.tsx
          where it was the only screen carrying one. Every control in this block
          is optional — eating styles, allergies and this field alike — so
          labelling the third of three implies the first two are required,
          which is the opposite of true. The ruling was "all four or none";
          none is the honest one. */}
      <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>Anything else?</Text>
      <Text style={s.helpText}>Any other dietary preferences?</Text>
      <TextInput
        value={dietaryNotes}
        // ⚠️ ONE BLANK-VALUE CONVENTION: "". The three screens previously
        // disagreed (undefined / "" + omit-on-PATCH / undefined) and converged
        // to the same stored state anyway, so nothing downstream depended on
        // the difference. The component takes and emits a plain string; each
        // screen maps "" to whatever its own transport wants at the boundary
        // (preferences.tsx -> undefined, wizard/tellkiwi -> undefined on send).
        onChangeText={onDietaryNotesChange}
        placeholder={DIETARY_NOTES_PLACEHOLDER}
        placeholderTextColor={Colors.neutral[700]}
        returnKeyType="done"
        blurOnSubmit
        onSubmitEditing={Keyboard.dismiss}
        style={s.input}
      />
    </View>
  );
}

const s = StyleSheet.create({
  // ⚠️ Byte-identical to the four local `subLabel` / `subSectionLabel` entries
  // this replaces — they were already the same five declarations in four
  // files, so nothing moves on any screen. (preferences.tsx's shared <SubLabel>
  // renders s.subSectionLabel, which is this.)
  subLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[2],
  },
  helpText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[2],
  },
  otherAllergies: {
    marginTop: Spacing[3],
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    textAlignVertical: "top",
  },
});
