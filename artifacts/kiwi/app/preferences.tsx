import React, { useState } from "react";
import {
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { DEFAULT_RETAILERS, PLAN_DURATION_PRESETS } from "@/lib/domain";
import { getCurrentUserPreferences } from "@/lib/stubs";
import type { UserPreferencesData } from "@/lib/types";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const KIDS_MIN = 0;
const KIDS_MAX = 8;

export default function Preferences() {
  const router = useRouter();
  const { updateUserPreferences } = useApp();

  const [form, setForm] = useState<UserPreferencesData>(() =>
    getCurrentUserPreferences(),
  );

  const update = <K extends keyof UserPreferencesData>(
    key: K,
    value: UserPreferencesData[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleHouseholdSizeChange = (newSize: number) => {
    setForm((prev) => ({
      ...prev,
      householdSize: newSize,
      // Auto-reduce dependents if they exceed the new max.
      kidsCount: Math.min(prev.kidsCount, newSize),
      pickyEaterCount: Math.min(prev.pickyEaterCount, newSize),
    }));
  };

  const handleSave = () => {
    Keyboard.dismiss();
    console.log("[preferences] save", form);
    void updateUserPreferences(form);

    Alert.alert(
      "Coming in WS7 — preferences save",
      "Updating preferences requires the API client. The values are captured (see console).",
      [{ text: "OK", onPress: () => router.back() }],
    );
  };

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

        {/* Submit + cancel */}
        <View style={s.footer}>
          <Button
            label="Save preferences"
            variant="terra"
            onPress={handleSave}
          />
          <Text style={s.footerHint}>Updates your saved preferences</Text>
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
