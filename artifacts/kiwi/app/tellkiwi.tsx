import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { LoadingShim } from "@/components/LoadingShim";
import { Stepper } from "@/components/Stepper";
import { AllergiesPicker } from "@/components/preference-pickers/AllergiesPicker";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { EatingStylesPicker } from "@/components/preference-pickers/EatingStylesPicker";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  COOK_TIME_CAP_OPTIONS,
  COOK_TIME_COVERAGE_OPTIONS,
  DISCOVERY_MEALS_OPTIONS,
  PLAN_DURATION_PRESETS,
  SAUCE_PREFERENCE_OPTIONS,
} from "@/lib/domain";
import type { TellKiwiInput } from "@/lib/types";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import { useBuildFromText } from "@/hooks/useBuildFromText";

type WeeklyPacing = NonNullable<TellKiwiInput["weeklyPacing"]>;
type SaucePreference = NonNullable<TellKiwiInput["saucePreference"]>;
type CookTimeCoverage = NonNullable<TellKiwiInput["maxCookTimeCoverage"]>;

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const DESCRIPTION_MAX = 500;
const DESCRIPTION_MIN = 5;

const PACING_OPTIONS: { key: WeeklyPacing; label: string }[] = [
  { key: "mostly_easy", label: "Mostly easy" },
  { key: "mixed", label: "Mixed (quick + nicer)" },
  { key: "one_fancy_night", label: "One fancy night" },
  { key: "minimal_effort", label: "Minimal effort" },
];

const PLACEHOLDER =
  "Describe what you'd like for the week. Examples: 'Comforting weeknight meals for a family of 4', 'Italian and Mediterranean only', 'burgers, mac and cheese, grilled chicken, soup, and pasta', or 'Easy meals my picky kids will eat plus one fancy night'";

interface TellKiwiFormState {
  description: string;
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  weeklyPacing: WeeklyPacing;
  eatingStyles: string[];
  allergies: string[];
  dietaryNotes: string;
  // Cookbook Phase B Block 4 (D-WS7-035) — per-run generation-shaping prefs,
  // hydrated from stored UserPreferences, editable for THIS plan only.
  discoveryMealsPerWeek: number;
  saucePreference: SaucePreference;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: CookTimeCoverage;
  /** "Adjust saved prefs for this plan" disclosure open state. */
  adjustExpanded: boolean;
}

// Fallback state before stored prefs hydrate (or if the read fails — hydration
// is an assist, not a blocker). Re-seeded from stored prefs by hydrateForm().
const INITIAL_FORM: TellKiwiFormState = {
  description: "",
  planDurationDays: 5,
  householdSize: 4,
  cuisines: [],
  weeklyPacing: "mostly_easy",
  eatingStyles: [],
  allergies: [],
  dietaryNotes: "",
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
  adjustExpanded: false,
};

// Preserve the user's free-text as they hydrate — the description box is the
// primary input and stored prefs never touch it. Only the disclosure controls
// are seeded from stored prefs.
function hydrateForm(
  prefs: UserPreferences,
  description: string,
): TellKiwiFormState {
  return {
    description,
    planDurationDays: prefs.planLengthDefault,
    householdSize: prefs.householdSize,
    cuisines: prefs.cuisines,
    weeklyPacing: prefs.weeklyPacingDefault ?? "mostly_easy",
    eatingStyles: prefs.eatingStyles,
    allergies: prefs.allergiesAndAvoidances,
    dietaryNotes: prefs.dietaryNotes ?? "",
    discoveryMealsPerWeek: prefs.discoveryMealsPerWeek,
    saucePreference: prefs.saucePreference,
    maxCookTimeMinutes: prefs.maxCookTimeMinutes,
    maxCookTimeCoverage: prefs.maxCookTimeCoverage,
    adjustExpanded: false,
  };
}

export default function TellKiwi() {
  const router = useRouter();
  // WS9 3a — free-text handoff from the Home Tell Kiwi card. `text` seeds the
  // description box so the user's typed prompt survives the navigation (no
  // retype). This is the handoff CONTRACT only; TODO(3c): 3c owns tellkiwi's
  // restyle + the explicit-list spectrum (§7.1) — this touches neither.
  const params = useLocalSearchParams<{ text?: string }>();
  const initialText = typeof params.text === "string" ? params.text : "";
  const [form, setForm] = useState<TellKiwiFormState>(() => ({
    ...INITIAL_FORM,
    description: initialText,
  }));
  const mutation = useBuildFromText();

  // Cookbook Phase B Block 4 — hydrate the disclosure controls from stored
  // prefs (D-WS7-035). Read-only: Tell Kiwi never PATCHes /me/preferences.
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
  });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (prefsQuery.data && !hydrated) {
      setForm((prev) => hydrateForm(prefsQuery.data!, prev.description));
      setHydrated(true);
    }
  }, [prefsQuery.data, hydrated]);

  const update = <K extends keyof TellKiwiFormState>(
    key: K,
    value: TellKiwiFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const buildPayload = (): TellKiwiInput => ({
    description: form.description.trim(),
    planDurationDays: form.planDurationDays,
    householdSize: form.householdSize,
    cuisines: form.cuisines,
    weeklyPacing: form.weeklyPacing,
    eatingStyles: form.eatingStyles,
    allergiesAndAvoidances: form.allergies,
    dietaryNotes: form.dietaryNotes.trim() || undefined,
    // Only send the four per-run overrides once stored prefs have hydrated the
    // controls — otherwise wizard defaults would clobber stored prefs via the
    // server resolver (D-WS7-035 precedence).
    ...(hydrated
      ? {
          discoveryMealsPerWeek: form.discoveryMealsPerWeek,
          saucePreference: form.saucePreference,
          maxCookTimeMinutes: form.maxCookTimeMinutes,
          maxCookTimeCoverage: form.maxCookTimeCoverage,
        }
      : {}),
  });

  const handleSubmit = () => {
    Keyboard.dismiss();
    if (form.description.trim().length < DESCRIPTION_MIN) {
      Alert.alert(
        "Tell Kiwi a bit more",
        "Describe what you'd like — at least a few words about meals, cuisines, or the kind of week you want.",
      );
      return;
    }

    const payload = buildPayload();

    mutation.mutate(payload, {
      onSuccess: (result) => {
        // Scenario F (unclear) — keep the user on this screen and show the
        // clarifying question inline. Mobile renders mutation.data.parsedIntent
        // and the needsClarification.reason in the inline notice block below.
        if (
          result.parsedIntent.scenario === "unclear" ||
          result.candidates.length === 0
        ) {
          return;
        }
        // PRD §6.5/§6.6 — share the wizard-results screen. Pass the result
        // payload via params so wizard-results renders without re-firing AI.
        // WS7-5b-mobile Block A — also pass the form payload so the per-
        // candidate "View Plan Details" CTA can build a candidateContext for
        // POST /wizard/expand on this path too (Set-Prefs already carries
        // its WizardPreferencesInput in `input`).
        router.push({
          pathname: "/wizard-results",
          params: {
            source: "tellkiwi",
            tellKiwiResult: JSON.stringify(result),
            tellKiwiInput: JSON.stringify(payload),
          },
        });
      },
    });
  };

  const handleRetryAfterUnclear = () => {
    // Reset the mutation so the inline clarification UI clears, but keep the
    // user's text so they can edit it instead of retyping from scratch.
    mutation.reset();
  };

  const charCount = form.description.length;
  const cuisineSelectedCount = form.cuisines.length;

  // Hydration gate — hold the form until stored prefs settle so the disclosure
  // doesn't flash unhydrated. On error we fall through (assist, not blocker).
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
        subtitle="Just say what you want"
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Free-text description (always visible). */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Tell Kiwi</Text>
          <Text style={s.cardTitle}>What do you want to eat?</Text>
          <Text style={s.cardSubtitle}>
            List your meals or what you're into. Kiwi builds the plan,
            reviews ingredients, and optimizes across the week.
          </Text>
          <View style={{ marginTop: Spacing[3] }}>
            <TextInput
              value={form.description}
              onChangeText={(v) =>
                update("description", v.slice(0, DESCRIPTION_MAX))
              }
              placeholder={PLACEHOLDER}
              placeholderTextColor={Colors.neutral[600]}
              multiline
              maxLength={DESCRIPTION_MAX}
              returnKeyType="default"
              blurOnSubmit
              style={[s.input, s.descriptionInput]}
            />
            <Text style={s.charCount}>
              {charCount}/{DESCRIPTION_MAX}
            </Text>
          </View>
        </View>

        {/* Section 2: Plan length (always visible) — matches the Set-Prefs
            wizard. Drives planDurationDays; the server reads it off the body. */}
        <Section label="Plan length" title="How long is this plan?">
          <View style={s.chipRow}>
            {PLAN_DURATION_PRESETS.map((n) => (
              <Chip
                key={n}
                label={n === 1 ? "1 day" : `${n} days`}
                selected={form.planDurationDays === n}
                onPress={() => update("planDurationDays", n)}
              />
            ))}
          </View>
        </Section>

        {/* Section 3: Household size (always visible). */}
        <Section label="Household" title="Cooking for">
          <Stepper
            value={form.householdSize}
            onChange={(n) => update("householdSize", n)}
            min={HOUSEHOLD_MIN}
            max={HOUSEHOLD_MAX}
            suffix={form.householdSize === 1 ? "person" : "people"}
          />
        </Section>

        {/* Collapsed disclosure: per-run overrides of saved prefs (D-WS7-035).
            Same idiom + 7 controls as the Set-Prefs wizard. */}
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

              {/* Dietary restrictions */}
              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Eating styles
              </Text>
              <EatingStylesPicker
                value={form.eatingStyles}
                onChange={(next) => update("eatingStyles", next)}
              />

              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Allergies & avoidances
              </Text>
              <AllergiesPicker
                value={form.allergies}
                onChange={(next) => update("allergies", next)}
              />

              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Anything else?
              </Text>
              <TextInput
                value={form.dietaryNotes}
                onChangeText={(v) => update("dietaryNotes", v)}
                placeholder="e.g., 'no shellfish', 'low sodium'"
                placeholderTextColor={Colors.neutral[600]}
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={Keyboard.dismiss}
                style={s.input}
              />

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

        {/* Inline status + clarification UI for the unclear scenario. */}
        {mutation.isError && (
          <View style={s.noticeCard}>
            <Text style={s.noticeTitle}>Kiwi got distracted. Try again?</Text>
            {mutation.error?.message ? (
              <Text style={s.noticeBody}>{mutation.error.message}</Text>
            ) : null}
          </View>
        )}

        {mutation.isSuccess &&
          mutation.data?.parsedIntent.scenario === "unclear" && (
            <View style={s.clarifyCard}>
              <Text style={s.clarifyTitle}>Kiwi needs a little more</Text>
              <Text style={s.clarifyBody}>
                {mutation.data.needsClarification?.reason ??
                  "Tell me a bit more — what kind of week do you want, or any meals you've been craving?"}
              </Text>
              <View style={{ marginTop: Spacing[2] }}>
                <Button
                  label="Edit my message"
                  variant="ghost"
                  onPress={handleRetryAfterUnclear}
                />
              </View>
            </View>
          )}

        {/* Submit + cancel */}
        <View style={s.footer}>
          <Button
            label={mutation.isPending ? "Kiwi is thinking…" : "Build my plan"}
            variant="primary"
            onPress={handleSubmit}
            disabled={mutation.isPending}
          />
          {mutation.isPending && (
            <LoadingShim variant="inline" label="Reading what you wrote…" />
          )}
          {!mutation.isPending && (
            <Text style={s.footerHint}>
              Kiwi cooks up your plan from what you wrote
            </Text>
          )}
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
    lineHeight: 20,
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
  descriptionInput: {
    minHeight: 110,
    maxHeight: 220,
    paddingVertical: Spacing[3],
    lineHeight: 22,
  },
  charCount: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
    textAlign: "right",
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
  noticeCard: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[3],
    marginTop: Spacing[3],
  },
  noticeTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  noticeBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  clarifyCard: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
    marginTop: Spacing[3],
  },
  clarifyTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  clarifyBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
});
