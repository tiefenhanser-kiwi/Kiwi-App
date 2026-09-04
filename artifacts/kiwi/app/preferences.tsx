import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { BudgetLevelPicker } from "@/components/preference-pickers/BudgetLevelPicker";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { DietarySection } from "@/components/preference-pickers/DietarySection";
import { EquipmentPicker } from "@/components/preference-pickers/EquipmentPicker";
import { HealthGoalsPicker } from "@/components/preference-pickers/HealthGoalsPicker";
import { PickyEatersPicker } from "@/components/preference-pickers/PickyEatersPicker";
import { RecurringItemsPicker } from "@/components/preference-pickers/RecurringItemsPicker";
import { SkillLevelPicker } from "@/components/preference-pickers/SkillLevelPicker";
import { SpicePicker } from "@/components/preference-pickers/SpicePicker";
import { StovetopPicker } from "@/components/preference-pickers/StovetopPicker";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastProvider";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  COOK_TIME_CAP_OPTIONS,
  COOK_TIME_COVERAGE_OPTIONS,
  DEFAULT_RETAILERS,
  DISCOVERY_MEALS_OPTIONS,
  PLAN_DURATION_PRESETS,
  SAUCE_PREFERENCE_OPTIONS,
} from "@/lib/domain";
import { getPreferences } from "@/lib/api/me";
import { useDebouncedAutoSave } from "@/hooks/useDebouncedAutoSave";
import type { UserPreferencesData } from "@/lib/types";
import { toFormState } from "@/lib/preferencesForm";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const KIDS_MIN = 0;
const KIDS_MAX = 8;

/** Inline result banner shown after a toggle attempt. */
type Status = { kind: "success" | "error"; text: string } | null;

// WS9 3d Part 3c (B5) — auto-save debounce. Coalesces rapid edits (chip taps,
// stepper holds, typing in the notes field) into one PATCH after the user
// settles, instead of a per-keystroke storm.
const AUTOSAVE_DEBOUNCE_MS = 800;

export default function Preferences() {
  const { updateUserPreferences, updateMarketingConsent } = useApp();
  const { showToast } = useToast();
  const auth = useAuth();
  const authUser = auth.user;

  // Read side — the server-merged preferences row. The form below is a local
  // edit buffer seeded once from this query.
  const prefsQuery = useQuery({
    queryKey: ["me", "preferences"],
    queryFn: () => getPreferences(),
    enabled: !!authUser,
  });

  const [form, setForm] = useState<UserPreferencesData | null>(null);
  const [marketingStatus, setMarketingStatus] = useState<Status>(null);

  // Seed the form once, when the query first resolves. Later refetches (e.g.
  // the post-save invalidation) don't clobber the user's in-progress edits.
  useEffect(() => {
    if (prefsQuery.data && !form) {
      setForm(toFormState(prefsQuery.data));
    }
  }, [prefsQuery.data, form]);

  // WS9 3d Part 3c (B5, RULED) — preferences AUTO-SAVE, no Save button / bar.
  // useDebouncedAutoSave (below) PATCHes the whole form whenever it changes
  // after the initial seed; the app-level toast (ToastProvider, reused from Part
  // 3b — no new save-indicator UI) confirms the write. The hook owns the seed-
  // skip (first non-null value is the server row, not an edit) AND the Part 3c-2
  // (B2) flush-on-unmount so a fast swipe-back within the debounce window no
  // longer drops the edit. No unsaved-changes state, so backing out (Header ← )
  // needs no warning.
  const persistPreferences = useCallback(
    async (next: UserPreferencesData) => {
      // wantsLeftovers is no longer user-set (D-WS7-190) — omit it from the
      // PATCH rather than echo back the stored value (see also the server-only
      // key peel in toFormState).
      const { wantsLeftovers: _omitLeftovers, ...prefsToSave } = next;
      try {
        await updateUserPreferences(prefsToSave);
        showToast({ message: "Preferences saved." });
      } catch {
        showToast({
          message: "Couldn't save your preferences. Please try again.",
        });
      }
    },
    [updateUserPreferences, showToast],
  );

  // WS9 3d Part 3c-2 (B2) — debounce + flush-on-unmount extracted to a
  // unit-testable hook. Coalesces rapid edits into one PATCH and, critically,
  // flushes a still-pending edit if the user swipes back within the 800ms window
  // (previously lost). The hook owns the seed-skip too, so `seededRef` is no
  // longer needed here.
  useDebouncedAutoSave({
    value: form,
    onSave: persistPreferences,
    delayMs: AUTOSAVE_DEBOUNCE_MS,
  });

  const update = <K extends keyof UserPreferencesData>(
    key: K,
    value: UserPreferencesData[K],
  ) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleHouseholdSizeChange = (newSize: number) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            householdSize: newSize,
            // Auto-reduce dependents if they exceed the new max.
            kidsCount: Math.min(prev.kidsCount, newSize),
            pickyEaterCount: Math.min(prev.pickyEaterCount, newSize),
          }
        : prev,
    );
  };

  const handleMarketingToggle = async (
    field: "marketingConsentEmail" | "marketingConsentSms",
    value: boolean,
  ) => {
    setMarketingStatus(null);
    const patch =
      field === "marketingConsentEmail"
        ? { marketingConsentEmail: value }
        : { marketingConsentSms: value };
    try {
      await updateMarketingConsent(patch);
    } catch {
      setMarketingStatus({
        kind: "error",
        text: "Couldn't update your communication preferences. Please try again.",
      });
    }
  };

  // Loading / error gate — render nothing editable until the form is seeded.
  if (!form) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Preferences" />
        <View style={s.loadingWrap}>
          {prefsQuery.isError ? (
            <Text style={s.loadingError}>
              Couldn't load your preferences. Pull back and try again.
            </Text>
          ) : (
            <ActivityIndicator color={Colors.sage[700]} />
          )}
        </View>
      </View>
    );
  }

  const cuisineSelectedCount = form.cuisines.length;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title="Preferences" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Household */}
        <Section title="Household">
          <SubLabel>Default servings</SubLabel>
          <Stepper
            value={form.householdSize}
            onChange={handleHouseholdSizeChange}
            min={HOUSEHOLD_MIN}
            max={HOUSEHOLD_MAX}
            suffix={form.householdSize === 1 ? "person" : "people"}
          />

          <SubLabel style={{ marginTop: Spacing[4] }}>
            Plan length default
          </SubLabel>
          <View style={s.chipRow}>
            {PLAN_DURATION_PRESETS.map((n) => (
              <Chip
                key={n}
                label={n === 1 ? "1 day" : `${n} days`}
                selected={form.planLengthDefault === n}
                onPress={() => update("planLengthDefault", n)}
              />
            ))}
          </View>
          <Text style={s.helpText}>days per plan</Text>

          <SubLabel style={{ marginTop: Spacing[4] }}>Max cook time</SubLabel>
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
          <Text style={s.helpText}>Cap on how long a dinner should take</Text>

          {form.maxCookTimeMinutes !== null && (
            <>
              <SubLabel style={{ marginTop: Spacing[4] }}>
                Apply the cap to
              </SubLabel>
              <View style={s.chipRow}>
                {COOK_TIME_COVERAGE_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    label={opt.label}
                    selected={form.maxCookTimeCoverage === opt.value}
                    onPress={() => update("maxCookTimeCoverage", opt.value)}
                  />
                ))}
              </View>
            </>
          )}

          <SubLabel style={{ marginTop: Spacing[4] }}>Discovery meals</SubLabel>
          <View style={s.chipRow}>
            {DISCOVERY_MEALS_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                selected={form.discoveryMealsPerWeek === opt.value}
                onPress={() => update("discoveryMealsPerWeek", opt.value)}
              />
            ))}
          </View>
          <Text style={s.helpText}>Add 1-2 novel meals to each plan</Text>

          <SubLabel style={{ marginTop: Spacing[4] }}>
            Kids in household
          </SubLabel>
          <Stepper
            value={form.kidsCount}
            onChange={(n) =>
              update("kidsCount", Math.min(n, form.householdSize))
            }
            min={KIDS_MIN}
            max={Math.min(KIDS_MAX, form.householdSize)}
            suffix={form.kidsCount === 1 ? "kid" : "kids"}
          />
          {/* Kid ages sub-section removed per WS5-5P-bis-fix. */}

          <SubLabel style={{ marginTop: Spacing[4] }}>Picky eaters</SubLabel>
          <PickyEatersPicker
            pickyCount={form.pickyEaterCount}
            pickyAvoidances={form.pickyAvoidances}
            onPickyCountChange={(n) => update("pickyEaterCount", n)}
            onPickyAvoidancesChange={(next) => update("pickyAvoidances", next)}
            maxPicky={form.householdSize}
          />
        </Section>

        {/* Section 2: Cuisines */}
        <Section
          title="Cuisines you'd like"
          subtitle={
            cuisineSelectedCount > 0
              ? `${cuisineSelectedCount} selected`
              : undefined
          }
        >
          <CuisinePicker
            value={form.cuisines}
            onChange={(next) => update("cuisines", next)}
          />
        </Section>

        {/* Section 3: Dietary */}
        {/* WS9 D-WS9-206/207 — the eating-styles label, the allergies picker
            and the "Anything else?" field are now <DietarySection>, shared with
            onboarding-prefs, wizard and tellkiwi. BUG-196 (the doubled
            allergies heading) and BUG-154 (the placeholder contrast) both
            landed on THIS screen only; the other three drifted because the
            chrome was hand-rolled per file. It is one component now.
            ⚠️ The <Section> wrapper and its title stay HERE — wizard and
            tellkiwi render this block with no title at all. */}
        <Section title="Dietary preferences">
          <DietarySection
            eatingStyles={form.eatingStyles}
            onEatingStylesChange={(next) => update("eatingStyles", next)}
            allergies={form.allergiesAndAvoidances}
            onAllergiesChange={(next) => update("allergiesAndAvoidances", next)}
            otherAllergies={form.otherAllergies}
            onOtherAllergiesChange={(next) => update("otherAllergies", next)}
            dietaryNotes={form.dietaryNotes ?? ""}
            // The screen keeps its own blank-value mapping at the transport
            // boundary: "" -> undefined, as before.
            onDietaryNotesChange={(v) =>
              update("dietaryNotes", v.length > 0 ? v : undefined)
            }
          />
        </Section>

        {/* Section 4: Cooking */}
        <Section title="Cooking">
          <SubLabel>Skill level</SubLabel>
          <SkillLevelPicker
            value={form.cookingSkill}
            onChange={(next) => update("cookingSkill", next)}
          />

          <SubLabel style={{ marginTop: Spacing[4] }}>
            Spice tolerance
          </SubLabel>
          <SpicePicker
            value={form.spiceTolerance}
            onChange={(next) => update("spiceTolerance", next)}
          />

          <SubLabel style={{ marginTop: Spacing[4] }}>Equipment</SubLabel>
          <EquipmentPicker
            value={form.cookingEquipment}
            onChange={(next) => update("cookingEquipment", next)}
          />

          <SubLabel style={{ marginTop: Spacing[4] }}>
            Stovetop type
          </SubLabel>
          <StovetopPicker
            value={form.stovetopType}
            onChange={(next) => update("stovetopType", next)}
          />

          <SubLabel style={{ marginTop: Spacing[4] }}>
            Sauces and Spice Mixes Preference
          </SubLabel>
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
        </Section>

        {/* Section 5: Health & Budget */}
        <Section title="Health & Budget">
          <SubLabel>Health goals</SubLabel>
          <HealthGoalsPicker
            value={form.healthGoals}
            onChange={(next) => update("healthGoals", next)}
          />

          <SubLabel style={{ marginTop: Spacing[4] }}>Budget level</SubLabel>
          <BudgetLevelPicker
            value={form.budgetLevel}
            onChange={(next) => update("budgetLevel", next)}
          />
        </Section>

        {/* Section 6: Recurring grocery items */}
        <Section
          title="Recurring grocery items"
          subtitle="Things you always need from the store"
        >
          <RecurringItemsPicker
            value={form.recurringGroceryItems}
            onChange={(next) => update("recurringGroceryItems", next)}
          />
        </Section>

        {/* Section 7: Retailer */}
        <Section title="Default grocery retailer">
          <View style={s.chipRow}>
            {DEFAULT_RETAILERS.map((r) => (
              <Chip
                key={r}
                label={r}
                selected={form.defaultRetailer === r}
                onPress={() => update("defaultRetailer", r)}
              />
            ))}
          </View>
        </Section>

        {/* Section 8: Communication preferences (D-WS7-025) — these toggles
            persist immediately to User via /me/profile; they are not part of
            the form buffer saved by "Save preferences" below. */}
        <Section title="Communication preferences">
          <View style={s.toggleRow}>
            <Text style={s.toggleSubtitle}>
              Email me with Kiwi tips and updates
            </Text>
            <Switch
              value={authUser?.marketingConsentEmail ?? false}
              onValueChange={(v) =>
                handleMarketingToggle("marketingConsentEmail", v)
              }
              trackColor={{
                false: Colors.neutral[400],
                true: Colors.sage[700],
              }}
              thumbColor={Colors.neutral[0]}
            />
          </View>
          <View style={[s.toggleRow, { marginTop: Spacing[3] }]}>
            <Text style={s.toggleSubtitle}>
              Text me with Kiwi tips and updates
            </Text>
            <Switch
              value={authUser?.marketingConsentSms ?? false}
              onValueChange={(v) =>
                handleMarketingToggle("marketingConsentSms", v)
              }
              trackColor={{
                false: Colors.neutral[400],
                true: Colors.sage[700],
              }}
              thumbColor={Colors.neutral[0]}
            />
          </View>
          {marketingStatus && (
            <Text style={[s.statusText, s.statusError]}>
              {marketingStatus.text}
            </Text>
          )}
        </Section>

        {/* WS9 3d Part 3c (B5) — auto-save: no Save button / bar. Edits persist
            automatically (debounced) and the app-level toast confirms each
            save; backing out via the header needs no unsaved-changes warning. */}
        <Text style={s.footerHint}>
          Changes save automatically
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {subtitle && <Text style={s.cardSubtitle}>{subtitle}</Text>}
      <View style={{ marginTop: Spacing[3] }}>{children}</View>
    </View>
  );
}

function SubLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  return <Text style={[s.subSectionLabel, style]}>{children}</Text>;
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[5],
  },
  loadingError: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textAlign: "center",
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
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
  subSectionLabel: {
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
    marginTop: Spacing[1],
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
  },
  toggleSubtitle: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
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
  statusText: {
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textAlign: "center",
    marginTop: Spacing[2],
  },
  statusError: {
    color: Colors.terracotta[700],
  },
  footerHint: {
    marginTop: Spacing[4],
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
