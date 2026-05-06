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
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  ALLERGIES_AND_AVOIDANCES,
  BUDGET_LEVELS,
  COMMON_RECURRING_ITEMS,
  COOKING_EQUIPMENT,
  COOKING_SKILL_LEVELS,
  CUISINES_TIER_1,
  CUISINES_TIER_2,
  DEFAULT_RETAILERS,
  EATING_STYLES,
  HEALTH_GOALS,
  KID_AGE_RANGES,
  PICKY_AVOIDANCES,
  PLAN_DURATION_PRESETS,
  SPICE_TOLERANCE_OPTIONS,
  STOVETOP_TYPES,
} from "@/lib/domain";
import { getCurrentUserPreferences } from "@/lib/stubs";
import type { UserPreferencesData } from "@/lib/types";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const KIDS_MIN = 0;
const KIDS_MAX = 8;
const PICKY_MIN = 0;
const PICKY_MAX = 8;

export default function Preferences() {
  const router = useRouter();
  const { updateUserPreferences } = useApp();

  const [form, setForm] = useState<UserPreferencesData>(() =>
    getCurrentUserPreferences(),
  );
  const [cuisineExpanded, setCuisineExpanded] = useState(false);
  const [allergiesExpanded, setAllergiesExpanded] = useState(false);
  const [customRecurringItem, setCustomRecurringItem] = useState("");

  const update = <K extends keyof UserPreferencesData>(
    key: K,
    value: UserPreferencesData[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleArrayItem = (
    key:
      | "cuisines"
      | "eatingStyles"
      | "allergiesAndAvoidances"
      | "cookingEquipment"
      | "kidAgeRanges"
      | "pickyAvoidances"
      | "healthGoals"
      | "recurringGroceryItems",
    item: string,
  ) => {
    setForm((prev) => {
      const current = prev[key];
      const next = current.includes(item)
        ? current.filter((i) => i !== item)
        : [...current, item];
      return { ...prev, [key]: next };
    });
  };

  const removeRecurringItem = (item: string) => {
    setForm((prev) => ({
      ...prev,
      recurringGroceryItems: prev.recurringGroceryItems.filter(
        (i) => i !== item,
      ),
    }));
  };

  const addRecurringItem = (item: string) => {
    const trimmed = item.trim();
    if (!trimmed) return;
    setForm((prev) =>
      prev.recurringGroceryItems.includes(trimmed)
        ? prev
        : {
            ...prev,
            recurringGroceryItems: [...prev.recurringGroceryItems, trimmed],
          },
    );
  };

  const handleAddCustomRecurring = () => {
    addRecurringItem(customRecurringItem);
    setCustomRecurringItem("");
    Keyboard.dismiss();
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
            onChange={(n) => update("householdSize", n)}
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
            onChange={(n) => update("kidsCount", n)}
            min={KIDS_MIN}
            max={KIDS_MAX}
            suffix={form.kidsCount === 1 ? "kid" : "kids"}
          />
          {form.kidsCount > 0 && (
            <View style={{ marginTop: KSpacing.md }}>
              <SubLabel>Kids' ages</SubLabel>
              <View style={s.checkboxList}>
                {KID_AGE_RANGES.map((age) => {
                  const checked = form.kidAgeRanges.includes(age);
                  return (
                    <Pressable
                      key={age}
                      onPress={() => toggleArrayItem("kidAgeRanges", age)}
                      style={({ pressed }) => [
                        s.checkboxRow,
                        pressed && { opacity: 0.7 },
                      ]}
                      hitSlop={6}
                    >
                      <View
                        style={[s.checkbox, checked && s.checkboxChecked]}
                      >
                        {checked && (
                          <Feather
                            name="check"
                            size={14}
                            color={KColors.neutral[0]}
                          />
                        )}
                      </View>
                      <Text style={s.checkboxLabel}>{age}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Picky eaters
          </SubLabel>
          <Stepper
            value={form.pickyEaterCount}
            onChange={(n) => update("pickyEaterCount", n)}
            min={PICKY_MIN}
            max={PICKY_MAX}
            suffix={form.pickyEaterCount === 1 ? "person" : "people"}
          />
          {form.pickyEaterCount > 0 && (
            <View style={{ marginTop: KSpacing.md }}>
              <SubLabel>What they avoid</SubLabel>
              <View style={s.chipRow}>
                {PICKY_AVOIDANCES.map((p) => (
                  <Chip
                    key={p}
                    label={p}
                    selected={form.pickyAvoidances.includes(p)}
                    onPress={() => toggleArrayItem("pickyAvoidances", p)}
                  />
                ))}
              </View>
            </View>
          )}
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
          <View style={s.chipRow}>
            {CUISINES_TIER_1.map((c) => (
              <Chip
                key={c}
                label={c}
                selected={form.cuisines.includes(c)}
                onPress={() => toggleArrayItem("cuisines", c)}
              />
            ))}
          </View>
          <ExpandLink
            expanded={cuisineExpanded}
            label="More cuisines"
            onPress={() => setCuisineExpanded((v) => !v)}
          />
          {cuisineExpanded && (
            <View style={[s.chipRow, { marginTop: KSpacing.sm }]}>
              {CUISINES_TIER_2.map((c) => (
                <Chip
                  key={c}
                  label={c}
                  selected={form.cuisines.includes(c)}
                  onPress={() => toggleArrayItem("cuisines", c)}
                />
              ))}
            </View>
          )}
        </Section>

        {/* Section 3: Dietary */}
        <Section title="Dietary preferences">
          <SubLabel>Eating styles</SubLabel>
          <View style={s.chipRow}>
            {EATING_STYLES.map((e) => (
              <Chip
                key={e}
                label={e}
                selected={form.eatingStyles.includes(e)}
                onPress={() => toggleArrayItem("eatingStyles", e)}
              />
            ))}
          </View>

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Allergies & avoidances
          </SubLabel>
          <ExpandLink
            expanded={allergiesExpanded}
            label="More"
            onPress={() => setAllergiesExpanded((v) => !v)}
          />
          {allergiesExpanded && (
            <View style={[s.chipRow, { marginTop: KSpacing.sm }]}>
              {ALLERGIES_AND_AVOIDANCES.map((a) => (
                <Chip
                  key={a}
                  label={a}
                  selected={form.allergiesAndAvoidances.includes(a)}
                  onPress={() =>
                    toggleArrayItem("allergiesAndAvoidances", a)
                  }
                />
              ))}
            </View>
          )}

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
          <View style={s.chipRow}>
            {COOKING_SKILL_LEVELS.map((skill) => (
              <Chip
                key={skill}
                label={skill}
                selected={form.cookingSkill === skill}
                onPress={() => update("cookingSkill", skill)}
              />
            ))}
          </View>

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Spice tolerance
          </SubLabel>
          <View style={s.chipRow}>
            {SPICE_TOLERANCE_OPTIONS.map((tol) => (
              <Chip
                key={tol}
                label={tol}
                selected={form.spiceTolerance === tol}
                onPress={() => update("spiceTolerance", tol)}
              />
            ))}
          </View>

          <SubLabel style={{ marginTop: KSpacing.lg }}>Equipment</SubLabel>
          <View style={s.chipRow}>
            {COOKING_EQUIPMENT.map((eq) => (
              <Chip
                key={eq}
                label={eq}
                selected={form.cookingEquipment.includes(eq)}
                onPress={() => toggleArrayItem("cookingEquipment", eq)}
              />
            ))}
          </View>

          <SubLabel style={{ marginTop: KSpacing.lg }}>
            Stovetop type
          </SubLabel>
          <View style={s.chipRow}>
            {STOVETOP_TYPES.map((t) => (
              <Chip
                key={t}
                label={t}
                selected={form.stovetopType === t}
                onPress={() => update("stovetopType", t)}
              />
            ))}
          </View>
        </Section>

        {/* Section 5: Health & Budget */}
        <Section title="Health & Budget">
          <SubLabel>Health goals</SubLabel>
          <View style={s.chipRow}>
            {HEALTH_GOALS.map((g) => (
              <Chip
                key={g}
                label={g}
                selected={form.healthGoals.includes(g)}
                onPress={() => toggleArrayItem("healthGoals", g)}
              />
            ))}
          </View>

          <SubLabel style={{ marginTop: KSpacing.lg }}>Budget level</SubLabel>
          <View style={s.chipRow}>
            {BUDGET_LEVELS.map((b) => (
              <Chip
                key={b}
                label={b}
                selected={form.budgetLevel === b}
                onPress={() => update("budgetLevel", b)}
              />
            ))}
          </View>
        </Section>

        {/* Section 6: Recurring grocery items */}
        <Section
          title="Recurring grocery items"
          subtitle="Things you always need from the store"
        >
          {form.recurringGroceryItems.length > 0 && (
            <View style={s.recurringList}>
              {form.recurringGroceryItems.map((item) => (
                <View key={item} style={s.recurringItem}>
                  <Text style={s.recurringItemText}>{item}</Text>
                  <Pressable
                    onPress={() => removeRecurringItem(item)}
                    hitSlop={8}
                    style={({ pressed }) => pressed && { opacity: 0.6 }}
                  >
                    <Feather
                      name="x"
                      size={16}
                      color={KColors.neutral[600]}
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <SubLabel style={{ marginTop: KSpacing.lg }}>Common items</SubLabel>
          <View style={s.chipRow}>
            {COMMON_RECURRING_ITEMS.map((item) => (
              <Chip
                key={item}
                label={item}
                selected={form.recurringGroceryItems.includes(item)}
                onPress={() => toggleArrayItem("recurringGroceryItems", item)}
              />
            ))}
          </View>

          <View style={s.customAddRow}>
            <TextInput
              value={customRecurringItem}
              onChangeText={setCustomRecurringItem}
              placeholder="Add custom item..."
              placeholderTextColor={KColors.neutral[600]}
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={handleAddCustomRecurring}
              style={[s.input, { flex: 1 }]}
            />
            <Pressable
              onPress={handleAddCustomRecurring}
              disabled={!customRecurringItem.trim()}
              hitSlop={8}
              style={({ pressed }) => [
                s.addBtn,
                !customRecurringItem.trim() && { opacity: 0.4 },
                pressed && customRecurringItem.trim() && { opacity: 0.7 },
              ]}
            >
              <Feather name="plus" size={20} color={KColors.neutral[0]} />
            </Pressable>
          </View>
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

        {/* Section 8: Notifications */}
        <Section
          title="Notifications"
          subtitle="Email and SMS marketing — opt in only"
        >
          <View style={s.toggleRow}>
            <Text style={s.toggleSubtitle}>Email marketing</Text>
            <Switch
              value={form.marketingConsentEmail}
              onValueChange={(v) => update("marketingConsentEmail", v)}
              trackColor={{
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
            />
          </View>
          <View style={[s.toggleRow, { marginTop: KSpacing.md }]}>
            <Text style={s.toggleSubtitle}>SMS marketing</Text>
            <Switch
              value={form.marketingConsentSms}
              onValueChange={(v) => update("marketingConsentSms", v)}
              trackColor={{
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
            />
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

function ExpandLink({
  expanded,
  label,
  onPress,
}: {
  expanded: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [s.expandLink, pressed && { opacity: 0.6 }]}
    >
      <Text style={s.expandLinkText}>{label}</Text>
      <Feather
        name={expanded ? "chevron-up" : "chevron-down"}
        size={14}
        color={KColors.sage[700]}
      />
    </Pressable>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  card: {
    backgroundColor: KColors.neutral[0],
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
  checkboxList: {
    gap: KSpacing.sm,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    paddingVertical: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: KRadius.sm,
    borderWidth: 2,
    borderColor: KColors.neutral[400],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: KColors.neutral[0],
  },
  checkboxChecked: {
    backgroundColor: KColors.sage[700],
    borderColor: KColors.sage[700],
  },
  checkboxLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
  },
  expandLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: KSpacing.sm,
    alignSelf: "flex-start",
  },
  expandLinkText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    textAlignVertical: "top",
  },
  recurringList: {
    gap: KSpacing.xs,
    marginBottom: KSpacing.sm,
  },
  recurringItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    backgroundColor: KColors.neutral[100],
    borderRadius: KRadius.md,
  },
  recurringItemText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  customAddRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    marginTop: KSpacing.md,
  },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: KRadius.md,
    backgroundColor: KColors.sage[700],
    alignItems: "center",
    justifyContent: "center",
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
