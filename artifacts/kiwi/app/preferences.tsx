import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { AllergiesPicker } from "@/components/preference-pickers/AllergiesPicker";
import { BudgetLevelPicker } from "@/components/preference-pickers/BudgetLevelPicker";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { EatingStylesPicker } from "@/components/preference-pickers/EatingStylesPicker";
import { EquipmentPicker } from "@/components/preference-pickers/EquipmentPicker";
import { HealthGoalsPicker } from "@/components/preference-pickers/HealthGoalsPicker";
import { PickyEatersPicker } from "@/components/preference-pickers/PickyEatersPicker";
import { RecurringItemsPicker } from "@/components/preference-pickers/RecurringItemsPicker";
import { SkillLevelPicker } from "@/components/preference-pickers/SkillLevelPicker";
import { SpicePicker } from "@/components/preference-pickers/SpicePicker";
import { StovetopPicker } from "@/components/preference-pickers/StovetopPicker";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { DEFAULT_RETAILERS, PLAN_DURATION_PRESETS } from "@/lib/domain";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import type { UserPreferencesData } from "@/lib/types";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const KIDS_MIN = 0;
const KIDS_MAX = 8;

/** Inline result banner shown after a save / toggle attempt. */
type Status = { kind: "success" | "error"; text: string } | null;

// GET /me/preferences sends `null` for the four optional String? columns;
// the form's UserPreferencesData uses `undefined`. Normalize on seed so the
// form is a clean UserPreferencesData.
function toFormState(p: UserPreferences): UserPreferencesData {
  return {
    ...p,
    cookingSkill: p.cookingSkill ?? undefined,
    stovetopType: p.stovetopType ?? undefined,
    defaultRetailer: p.defaultRetailer ?? undefined,
    dietaryNotes: p.dietaryNotes ?? undefined,
  };
}

export default function Preferences() {
  const router = useRouter();
  const { updateUserPreferences, updateMarketingConsent } = useApp();
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
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Status>(null);
  const [marketingStatus, setMarketingStatus] = useState<Status>(null);

  // Seed the form once, when the query first resolves. Later refetches (e.g.
  // the post-save invalidation) don't clobber the user's in-progress edits.
  useEffect(() => {
    if (prefsQuery.data && !form) {
      setForm(toFormState(prefsQuery.data));
    }
  }, [prefsQuery.data, form]);

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

  const handleSave = async () => {
    if (!form) return;
    Keyboard.dismiss();
    setSaveStatus(null);
    setSaving(true);
    try {
      await updateUserPreferences(form);
      setSaveStatus({ kind: "success", text: "Preferences saved." });
    } catch {
      setSaveStatus({
        kind: "error",
        text: "Couldn't save your preferences. Please try again.",
      });
    } finally {
      setSaving(false);
    }
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
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack title="Preferences" />
        <View style={s.loadingWrap}>
          {prefsQuery.isError ? (
            <Text style={s.loadingError}>
              Couldn't load your preferences. Pull back and try again.
            </Text>
          ) : (
            <ActivityIndicator color={KColors.sage[700]} />
          )}
        </View>
      </View>
    );
  }

  const cuisineSelectedCount = form.cuisines.length;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
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

          <SubLabel style={{ marginTop: KSpacing.lg }}>
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

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Wants leftovers
          </SubLabel>
          <View style={s.toggleRow}>
            <Text style={s.toggleSubtitle}>
              Kiwi sizes portions to leave planned extras
            </Text>
            <Switch
              value={form.wantsLeftovers}
              onValueChange={(v) => update("wantsLeftovers", v)}
              trackColor={{
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
            />
          </View>

          <SubLabel style={{ marginTop: KSpacing.lg }}>
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

          <SubLabel style={{ marginTop: KSpacing.lg }}>Picky eaters</SubLabel>
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
        <Section title="Dietary preferences">
          <SubLabel>Eating styles</SubLabel>
          <EatingStylesPicker
            value={form.eatingStyles}
            onChange={(next) => update("eatingStyles", next)}
          />

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Allergies & avoidances
          </SubLabel>
          <AllergiesPicker
            value={form.allergiesAndAvoidances}
            onChange={(next) => update("allergiesAndAvoidances", next)}
          />

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Anything else?
          </SubLabel>
          <TextInput
            value={form.dietaryNotes ?? ""}
            onChangeText={(v) =>
              update("dietaryNotes", v.length > 0 ? v : undefined)
            }
            placeholder="e.g., 'no cilantro', 'lower sodium'"
            placeholderTextColor={KColors.neutral[600]}
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={Keyboard.dismiss}
            style={s.input}
          />
        </Section>

        {/* Section 4: Cooking */}
        <Section title="Cooking">
          <SubLabel>Skill level</SubLabel>
          <SkillLevelPicker
            value={form.cookingSkill}
            onChange={(next) => update("cookingSkill", next)}
          />

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Spice tolerance
          </SubLabel>
          <SpicePicker
            value={form.spiceTolerance}
            onChange={(next) => update("spiceTolerance", next)}
          />

          <SubLabel style={{ marginTop: KSpacing.lg }}>Equipment</SubLabel>
          <EquipmentPicker
            value={form.cookingEquipment}
            onChange={(next) => update("cookingEquipment", next)}
          />

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Stovetop type
          </SubLabel>
          <StovetopPicker
            value={form.stovetopType}
            onChange={(next) => update("stovetopType", next)}
          />
        </Section>

        {/* Section 5: Health & Budget */}
        <Section title="Health & Budget">
          <SubLabel>Health goals</SubLabel>
          <HealthGoalsPicker
            value={form.healthGoals}
            onChange={(next) => update("healthGoals", next)}
          />

          <SubLabel style={{ marginTop: KSpacing.lg }}>Budget level</SubLabel>
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
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
            />
          </View>
          <View style={[s.toggleRow, { marginTop: KSpacing.md }]}>
            <Text style={s.toggleSubtitle}>
              Text me with Kiwi tips and updates
            </Text>
            <Switch
              value={authUser?.marketingConsentSms ?? false}
              onValueChange={(v) =>
                handleMarketingToggle("marketingConsentSms", v)
              }
              trackColor={{
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
            />
          </View>
          {marketingStatus && (
            <Text style={[s.statusText, s.statusError]}>
              {marketingStatus.text}
            </Text>
          )}
        </Section>

        {/* Submit + cancel */}
        <View style={s.footer}>
          <Button
            label="Save preferences"
            variant="terra"
            loading={saving}
            disabled={saving}
            onPress={handleSave}
          />
          {saveStatus ? (
            <Text
              style={[
                s.statusText,
                saveStatus.kind === "error"
                  ? s.statusError
                  : s.statusSuccess,
              ]}
            >
              {saveStatus.text}
            </Text>
          ) : (
            <Text style={s.footerHint}>Updates your saved preferences</Text>
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
      <View style={{ marginTop: KSpacing.md }}>{children}</View>
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
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.xl,
  },
  loadingError: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    textAlign: "center",
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  cardTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  subSectionLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  helpText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.xs,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
  },
  toggleSubtitle: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    textAlignVertical: "top",
  },
  statusText: {
    fontSize: KType.size.sm,
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    textAlign: "center",
    marginTop: KSpacing.sm,
  },
  statusSuccess: {
    color: KColors.sage[700],
  },
  statusError: {
    color: KColors.terracotta[700],
  },
  footer: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
    alignItems: "center",
  },
  footerHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  cancelLink: {
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    marginTop: KSpacing.xs,
  },
  cancelText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
});
