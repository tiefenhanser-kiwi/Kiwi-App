import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { BudgetLevelPicker } from "@/components/preference-pickers/BudgetLevelPicker";
import { EquipmentPicker } from "@/components/preference-pickers/EquipmentPicker";
import { HealthGoalsPicker } from "@/components/preference-pickers/HealthGoalsPicker";
import { PickyEatersPicker } from "@/components/preference-pickers/PickyEatersPicker";
import { SpicePicker } from "@/components/preference-pickers/SpicePicker";
import { StovetopPicker } from "@/components/preference-pickers/StovetopPicker";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getCurrentUserPreferences } from "@/lib/stubs";
import type { UserPreferencesData } from "@/lib/types";

const KIDS_MIN = 0;
const KIDS_MAX = 8;
const PICKY_MAX = 8;

type SectionId =
  | "equipment"
  | "kids"
  | "picky"
  | "spice"
  | "health"
  | "budget";

type Step3FormState = {
  cookingEquipment: string[];
  stovetopType?: "Gas" | "Induction" | "Electric";
  kidsCount: number;
  pickyEaterCount: number;
  pickyAvoidances: string[];
  spiceTolerance: "Mild" | "Medium" | "Hot" | "Very Hot";
  healthGoals: string[];
  budgetLevel: "Economy" | "Mid-range" | "Premium";
};

export default function OnboardingTellKiwi() {
  const router = useRouter();
  const { updateUserPreferences, setOnboardingComplete } = useApp();

  const [form, setForm] = useState<Step3FormState>({
    cookingEquipment: [],
    stovetopType: undefined,
    kidsCount: 0,
    pickyEaterCount: 0,
    pickyAvoidances: [],
    spiceTolerance: "Medium",
    healthGoals: [],
    budgetLevel: "Mid-range",
  });

  const [expanded, setExpanded] = useState<Set<SectionId>>(new Set());

  const toggleSection = (id: SectionId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const update = <K extends keyof Step3FormState>(
    key: K,
    value: Step3FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // For WS5, step 2's values aren't threaded into step 3 (each onboarding
  // screen is independent). We reconstruct a full UserPreferencesData by
  // using getCurrentUserPreferences for the §3.4 fields and overlaying the
  // §3.5 fields the user just touched here. WS7's real persistence is
  // server-merge; this stub-log shape just helps devs see what the user
  // picked on this screen alongside sensible defaults for the rest.
  const buildFullPrefs = (): UserPreferencesData => {
    const base = getCurrentUserPreferences();
    return {
      ...base,
      cookingEquipment: form.cookingEquipment,
      stovetopType: form.stovetopType,
      kidsCount: form.kidsCount,
      pickyEaterCount: form.pickyEaterCount,
      pickyAvoidances: form.pickyAvoidances,
      spiceTolerance: form.spiceTolerance,
      healthGoals: form.healthGoals,
      budgetLevel: form.budgetLevel,
    };
  };

  const handleSaveAndWizard = () => {
    console.log("[onboarding-step-3] save + wizard", form);
    void updateUserPreferences(buildFullPrefs());
    void setOnboardingComplete(true);
    // Skip /wizard prefs page — user already set general prefs in steps 2+3.
    // dismissAll clears the onboarding stack so back-swipe can't return here.
    router.dismissAll();
    router.replace("/wizard-results");
  };

  const handleSaveAndHome = () => {
    console.log("[onboarding-step-3] save + home", form);
    void updateUserPreferences(buildFullPrefs());
    void setOnboardingComplete(true);
    router.dismissAll();
    router.replace("/(tabs)");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title="Tell Kiwi more" subtitle="Step 3 of 3" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.helperCard}>
          <Text style={s.helperHeading}>
            Help Kiwi understand more to make better recommendations
          </Text>
          <Text style={s.helperBody}>
            All optional — pick what's relevant. The more you share, the
            smarter Kiwi gets.
          </Text>
        </View>

        <CollapsibleSection
          id="equipment"
          title="Cooking equipment"
          subtitle="What's in your kitchen — so Kiwi doesn't suggest recipes you can't make"
          isOpen={expanded.has("equipment")}
          onToggle={() => toggleSection("equipment")}
        >
          <EquipmentPicker
            value={form.cookingEquipment}
            onChange={(next) => update("cookingEquipment", next)}
          />
          <Text style={[s.subLabel, { marginTop: KSpacing.lg }]}>
            Stovetop type
          </Text>
          <StovetopPicker
            value={form.stovetopType}
            onChange={(next) => update("stovetopType", next)}
          />
        </CollapsibleSection>

        <CollapsibleSection
          id="kids"
          title="Kids in household"
          subtitle="Helps Kiwi suggest portion sizes and kid-friendly options"
          isOpen={expanded.has("kids")}
          onToggle={() => toggleSection("kids")}
        >
          <Stepper
            value={form.kidsCount}
            onChange={(n) => update("kidsCount", n)}
            min={KIDS_MIN}
            max={KIDS_MAX}
            suffix={form.kidsCount === 1 ? "kid" : "kids"}
          />
        </CollapsibleSection>

        <CollapsibleSection
          id="picky"
          title="Picky eaters"
          subtitle="Things they just won't eat (different from dietary restrictions)"
          isOpen={expanded.has("picky")}
          onToggle={() => toggleSection("picky")}
        >
          <PickyEatersPicker
            pickyCount={form.pickyEaterCount}
            pickyAvoidances={form.pickyAvoidances}
            onPickyCountChange={(n) => update("pickyEaterCount", n)}
            onPickyAvoidancesChange={(next) => update("pickyAvoidances", next)}
            maxPicky={PICKY_MAX}
          />
        </CollapsibleSection>

        <CollapsibleSection
          id="spice"
          title="Spice tolerance"
          isOpen={expanded.has("spice")}
          onToggle={() => toggleSection("spice")}
        >
          <SpicePicker
            value={form.spiceTolerance}
            onChange={(next) => update("spiceTolerance", next)}
          />
        </CollapsibleSection>

        <CollapsibleSection
          id="health"
          title="Health goals"
          subtitle="Note: not medical advice. Influences macro emphasis only."
          isOpen={expanded.has("health")}
          onToggle={() => toggleSection("health")}
        >
          <HealthGoalsPicker
            value={form.healthGoals}
            onChange={(next) => update("healthGoals", next)}
          />
        </CollapsibleSection>

        <CollapsibleSection
          id="budget"
          title="Budget level"
          isOpen={expanded.has("budget")}
          onToggle={() => toggleSection("budget")}
        >
          <BudgetLevelPicker
            value={form.budgetLevel}
            onChange={(next) => update("budgetLevel", next)}
          />
        </CollapsibleSection>

        <View style={s.footer}>
          <Button
            label="Get Kitchen Wizard Plans"
            variant="terra"
            onPress={handleSaveAndWizard}
          />
          <Text style={s.footerHint}>
            Save preferences and start a personalized plan
          </Text>
          <View style={{ height: KSpacing.sm }} />
          <Button
            label="Continue to Home"
            variant="secondary"
            onPress={handleSaveAndHome}
          />
          <Text style={s.footerHint}>
            Save preferences and explore the app
          </Text>
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  isOpen,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  subtitle?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={s.card}>
      <Pressable
        onPress={onToggle}
        hitSlop={6}
        style={({ pressed }) => [s.cardHeader, pressed && { opacity: 0.7 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{title}</Text>
          {subtitle && <Text style={s.cardSubtitle}>{subtitle}</Text>}
        </View>
        <Feather
          name={isOpen ? "chevron-up" : "chevron-down"}
          size={20}
          color={KColors.neutral[600]}
        />
      </Pressable>
      {isOpen && <View style={{ marginTop: KSpacing.md }}>{children}</View>}
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  helperCard: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
  },
  helperHeading: {
    fontSize: KType.size.md,
    color: KColors.sage[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  helperBody: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    lineHeight: 18,
  },
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
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
  subLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  footer: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
    alignItems: "stretch",
  },
  footerHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
