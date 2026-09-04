import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { WizardPreviousOptionsLink } from "@/components/WizardPreviousOptionsLink";
import { DietarySection } from "@/components/preference-pickers/DietarySection";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  COOK_TIME_CAP_OPTIONS,
  COOK_TIME_COVERAGE_OPTIONS,
  DISCOVERY_MEALS_OPTIONS,
  PLAN_DURATION_PRESETS,
  SAUCE_PREFERENCE_OPTIONS,
} from "@/lib/domain";
import type { WizardPreferencesInput } from "@/lib/types";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import { buildWizardPayload } from "@/lib/wizard/perRunPayload";

type Difficulty = WizardPreferencesInput["difficulty"];
type WeeklyPacing = WizardPreferencesInput["weeklyPacing"];
type SaucePreference = NonNullable<WizardPreferencesInput["saucePreference"]>;
type CookTimeCoverage = NonNullable<WizardPreferencesInput["maxCookTimeCoverage"]>;

const PACING_OPTIONS: { key: WeeklyPacing; label: string }[] = [
  { key: "mostly_easy", label: "Mostly easy" },
  { key: "mixed", label: "Mixed (quick + nicer)" },
  { key: "one_fancy_night", label: "One fancy night" },
  { key: "minimal_effort", label: "Minimal effort" },
];

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;

interface WizardFormState {
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  eatingStyles: string[];
  allergies: string[];
  dietaryNotes: string;
  /** WS9 D-WS9-206 — free-text allergy terms. PER-RUN, exactly like
   *  `allergies` and `dietaryNotes` beside it: hydrated from stored prefs so a
   *  saved allergy is never silently dropped from a run, edited freely for
   *  this plan, and NEVER written back to /me/preferences. */
  otherAllergies: string[];
  /** Hidden from UI per WS5-5N-bis-fix-wizard-fix; kept on state so
   *  the payload still carries the field. */
  difficulty: Difficulty;
  weeklyPacing: WeeklyPacing;
  additionalNotes: string;
  // Cookbook Phase B Block 4 (D-WS7-035) — the four generation-shaping prefs,
  // hydrated from stored UserPreferences and editable for THIS plan only.
  discoveryMealsPerWeek: number;
  saucePreference: SaucePreference;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: CookTimeCoverage;
  /** "Adjust saved prefs for this plan" disclosure open state. */
  adjustExpanded: boolean;
}

// TODO(WS5-5P + WS7): Wire from user's stored skill level per PRD §5.3
// — Beginner→Easy, Intermediate→Medium, Advanced→Fancy. Until Profile
// (5P) ships, hardcoded to "medium" and not surfaced in the wizard UI.
//
// WS9 3c Ruling 3 (D-WS9-031): `difficulty` was NOT dropped here even though it
// is unsurfaced — it is a REQUIRED enum on the server's WizardInputSchema and
// is consumed in expand + materialize, so omitting it 400s build-plans. It IS
// vestigial and should be removed properly.
// TODO(server): difficulty is vestigial — remove from WizardInputSchema +
// expand/materialize consumers when the wizard server schema is next revised
// (D-WS9-031).
const HIDDEN_DEFAULT_DIFFICULTY: Difficulty = "medium";

// Fallback state before stored preferences hydrate (or if the prefs read
// fails — hydration is an assist, not a blocker). Once prefs load, the four
// Phase-B fields + cuisines/pacing/diet/household/plan-length are re-seeded
// from the stored values by hydrateForm() below.
const INITIAL_FORM: WizardFormState = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: ["American", "Mexican"],
  eatingStyles: [],
  allergies: [],
  dietaryNotes: "",
  otherAllergies: [],
  difficulty: HIDDEN_DEFAULT_DIFFICULTY,
  weeklyPacing: "mostly_easy",
  additionalNotes: "",
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
  adjustExpanded: false,
};

// Cookbook Phase B Block 4 — seed the form from the user's stored prefs on
// wizard open (D-WS7-035 hydrate step). Edits mutate local state only; nothing
// here writes back to /me/preferences.
function hydrateForm(prefs: UserPreferences): WizardFormState {
  return {
    planDurationDays: prefs.planLengthDefault,
    householdSize: prefs.householdSize,
    cuisines: prefs.cuisines,
    eatingStyles: prefs.eatingStyles,
    allergies: prefs.allergiesAndAvoidances,
    dietaryNotes: prefs.dietaryNotes ?? "",
    otherAllergies: prefs.otherAllergies,
    difficulty: HIDDEN_DEFAULT_DIFFICULTY,
    weeklyPacing: prefs.weeklyPacingDefault ?? "mostly_easy",
    additionalNotes: "",
    discoveryMealsPerWeek: prefs.discoveryMealsPerWeek,
    saucePreference: prefs.saucePreference,
    maxCookTimeMinutes: prefs.maxCookTimeMinutes,
    maxCookTimeCoverage: prefs.maxCookTimeCoverage,
    adjustExpanded: false,
  };
}

export default function Wizard() {
  const router = useRouter();
  // PRD §9.4 — when launched from the AddMealToPlanSheet "Create new
  // plan" path, the meal id we should attach to the new plan arrives
  // as a route param. WS5: param plumbing only — actual attach +
  // redirect to /plan/{newPlanId} lands in WS7.
  const params = useLocalSearchParams<{ addMealId?: string }>();

  useEffect(() => {
    if (params.addMealId) {
      console.log("[wizard] received addMealId", params.addMealId);
    }
  }, [params.addMealId]);

  // Cookbook Phase B Block 4 — stored prefs hydrate the wizard controls
  // (D-WS7-035). Read-only here: the wizard never PATCHes /me/preferences.
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
  });

  const [form, setForm] = useState<WizardFormState>(INITIAL_FORM);
  // Once stored prefs arrive we seed the form exactly once. `hydrated` also
  // gates whether the four Phase-B overrides are sent on submit: if the prefs
  // read failed we must NOT send the wizard-default values (they would clobber
  // the user's real stored prefs via the server resolver) — omit them so the
  // server falls back to stored.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (prefsQuery.data && !hydrated) {
      setForm(hydrateForm(prefsQuery.data));
      setHydrated(true);
    }
  }, [prefsQuery.data, hydrated]);

  const update = <K extends keyof WizardFormState>(
    key: K,
    value: WizardFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSelectDuration = (n: number) => {
    update("planDurationDays", n);
  };

  const handleSubmit = () => {
    Keyboard.dismiss();
    // WS9 BUG-201 — the payload AND its hydration gate now live in
    // lib/wizard/perRunPayload.ts. app/** is outside the test glob (D-WS9-164)
    // and this gate decides whether a stale `[]` allergy list reaches plan
    // generation, so it is moved somewhere it can actually be pinned. The rule
    // and the reasoning are documented there.
    const payload: WizardPreferencesInput = buildWizardPayload(form, hydrated);
    console.log("[wizard] submit", payload);
    // WS6 6a-3 — payload travels to wizard-results as a JSON-encoded route
    // param; that screen calls POST /api/wizard/build-plans on mount.
    router.push({
      pathname: "/wizard-results",
      params: { input: JSON.stringify(payload) },
    });
  };

  const cuisineSelectedCount = form.cuisines.length;

  // ── prefs-hydration gate ─────────────────────────────────────────────
  // Show a short loader while stored prefs are in flight so the inputs don't
  // flash unhydrated. On a prefs error we fall through — hydration is an
  // assist, not a blocker (the form renders with defaults). WS9 3c removed the
  // mount-time resume interstitial (and its drafts-list / dismissed-drafts
  // machinery); "See Previous Options" (rendered below) is the recall path now.
  if (prefsQuery.isLoading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: Colors.neutral[100],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={Colors.sage[700]} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header
        showBack
        title="Kitchen Wizard"
        subtitle="Set preferences"
      />
      <KeyboardAwareScrollViewCompat
        // WS9 3f-4c (BUG-064) — the notes field sits at the bottom of the form;
        // with the default bottomOffset (0) the focused caret aligns flush with
        // the keyboard top, so on focus the field reads as covered. Give it
        // clearance so KeyboardAwareScrollView lifts the caret clear of the
        // keyboard. (The wrapper was already here — this tunes it, no new dep.)
        bottomOffset={Spacing[6]}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Block 4b-3 — "See Previous Options" (hidden when no batch). */}
        <WizardPreviousOptionsLink />

        {/* Always visible: Plan duration */}
        <Section label="Plan length" title="How long is this plan?">
          <View style={s.chipRow}>
            {PLAN_DURATION_PRESETS.map((n) => (
              <Chip
                key={n}
                label={n === 1 ? "1 day" : `${n} days`}
                selected={form.planDurationDays === n}
                onPress={() => handleSelectDuration(n)}
              />
            ))}
          </View>
        </Section>

        {/* Always visible: Household size */}
        <Section label="Household" title="Cooking for">
          <Stepper
            value={form.householdSize}
            onChange={(n) => update("householdSize", n)}
            min={HOUSEHOLD_MIN}
            max={HOUSEHOLD_MAX}
            suffix={form.householdSize === 1 ? "person" : "people"}
          />
        </Section>

        {/* Collapsed disclosure: per-run overrides of saved prefs.
            (D-WS7-035) — hydrated from stored prefs, edits apply to THIS plan
            only and never write back. Reuses the inline collapsible-card idiom
            from the former Dietary card. */}
        <View style={s.card}>
          <Pressable
            onPress={() => update("adjustExpanded", !form.adjustExpanded)}
            style={({ pressed }) => [
              s.dietHeader,
              pressed && { opacity: 0.7 },
            ]}
            hitSlop={6}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Adjust saved prefs for this plan</Text>
              <Text style={s.cardSubtitle}>
                Optional — changes apply to this plan only
              </Text>
            </View>
            <Feather
              name={form.adjustExpanded ? "chevron-up" : "chevron-down"}
              size={20}
              color={Colors.neutral[700]}
            />
          </Pressable>

          {form.adjustExpanded && (
            <View style={s.dietBody}>
              {/* Cuisines */}
              <Text style={s.subSectionLabel}>
                Cuisines
                {cuisineSelectedCount > 0
                  ? ` · ${cuisineSelectedCount} selected`
                  : ""}
              </Text>
              <CuisinePicker
                value={form.cuisines}
                onChange={(next) => update("cuisines", next)}
              />

              {/* Weekly pacing */}
              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Weekly pacing
              </Text>
              <View style={s.chipRow}>
                {PACING_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.key}
                    label={opt.label}
                    selected={form.weeklyPacing === opt.key}
                    onPress={() => update("weeklyPacing", opt.key)}
                  />
                ))}
              </View>

              {/* Dietary restrictions — WS9 D-WS9-206/207, the shared
                  <DietarySection>. This screen and its near-clone sibling were
                  ~110 structurally identical lines differing only in the
                  placeholder text.

                  ⚠️ THE "Allergies & avoidances" <Text> HEADING IS DELETED. It
                  was a BUG-196 regression: that fix moved the heading into
                  AllergiesPicker's own expander and deleted the orphan label in
                  preferences.tsx only, so this screen printed it twice.

                  ⚠️ NOTHING PERSISTS FROM HERE. The block sits inside the
                  "Adjust..." card, under "Optional — changes apply to this plan
                  only"; that framing and the card wrapper stay on the screen,
                  which is exactly why the shared component owns no <Section>
                  and no title of its own. */}
              <View style={{ marginTop: Spacing[4] }}>
                <DietarySection
                  eatingStyles={form.eatingStyles}
                  onEatingStylesChange={(next) => update("eatingStyles", next)}
                  allergies={form.allergies}
                  onAllergiesChange={(next) => update("allergies", next)}
                  otherAllergies={form.otherAllergies}
                  onOtherAllergiesChange={(next) =>
                    update("otherAllergies", next)
                  }
                  dietaryNotes={form.dietaryNotes}
                  onDietaryNotesChange={(v) => update("dietaryNotes", v)}
                  // WS9 BUG-201 — the screen renders past a prefs error by
                  // design; this makes it SAY so instead of showing an empty
                  // allergy list that means "you have none".
                  prefsUnavailable={prefsQuery.isError}
                />
              </View>

              {/* Discovery meals */}
              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Discovery meals
              </Text>
              <View style={s.chipRow}>
                {DISCOVERY_MEALS_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    label={opt.label}
                    selected={form.discoveryMealsPerWeek === opt.value}
                    onPress={() =>
                      update("discoveryMealsPerWeek", opt.value)
                    }
                  />
                ))}
              </View>

              {/* Sauce preference */}
              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Sauces and Spice Mixes Preference
              </Text>
              <View style={s.chipRow}>
                {SAUCE_PREFERENCE_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    label={opt.label}
                    selected={form.saucePreference === opt.value}
                    onPress={() => update("saucePreference", opt.value)}
                  />
                ))}
              </View>

              {/* Cook time cap */}
              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Max cook time
              </Text>
              <View style={s.chipRow}>
                {COOK_TIME_CAP_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.label}
                    label={opt.label}
                    selected={form.maxCookTimeMinutes === opt.value}
                    onPress={() => update("maxCookTimeMinutes", opt.value)}
                  />
                ))}
              </View>

              {/* Cook time coverage — gated: only when a cap is set. */}
              {form.maxCookTimeMinutes !== null && (
                <>
                  <Text
                    style={[s.subSectionLabel, { marginTop: Spacing[4] }]}
                  >
                    Apply the cap to
                  </Text>
                  <View style={s.chipRow}>
                    {COOK_TIME_COVERAGE_OPTIONS.map((opt) => (
                      <Chip
                        key={opt.value}
                        label={opt.label}
                        selected={form.maxCookTimeCoverage === opt.value}
                        onPress={() =>
                          update("maxCookTimeCoverage", opt.value)
                        }
                      />
                    ))}
                  </View>
                </>
              )}
            </View>
          )}
        </View>

        {/* Always visible: optional free text (kept expanded per Block 4). */}
        <Section
          label="Notes"
          title="Anything specific for this plan?"
          subtitle="Optional"
        >
          <TextInput
            value={form.additionalNotes}
            onChangeText={(v) => update("additionalNotes", v)}
            placeholder="e.g., a comforting week, planning to entertain Saturday, lots of veggies"
            placeholderTextColor={Palette.text.placeholder}
            multiline
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={Keyboard.dismiss}
            style={[s.input, { minHeight: 80 }]}
          />
        </Section>

        {/* Submit + cancel */}
        <View style={s.footer}>
          <Button
            label="Build my plan"
            variant="primary"
            onPress={handleSubmit}
          />
          <Text style={s.footerHint}>
            Kiwi generates 3 options to choose from
          </Text>
          <Pressable
            onPress={() => router.back()}
            hitSlop={6}
            style={({ pressed }) => [
              s.cancelLink,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function Section({
  label,
  title,
  subtitle,
  children,
}: {
  label: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={s.card}>
      <Text style={s.sectionLabel}>{label}</Text>
      <Text style={s.cardTitle}>{title}</Text>
      {subtitle && <Text style={s.cardSubtitle}>{subtitle}</Text>}
      <View style={{ marginTop: Spacing[3] }}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
  },
  sectionLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: Typography.face.sans[600],
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  dietHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  dietBody: {
    marginTop: Spacing[4],
  },
  subSectionLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[2],
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
  footer: {
    marginTop: Spacing[4],
    gap: Spacing[2],
    alignItems: "center",
  },
  footerHint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  cancelLink: {
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[3],
    marginTop: Spacing[1],
  },
  cancelText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
