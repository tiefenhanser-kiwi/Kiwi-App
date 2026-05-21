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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
  stovetopType?: "gas" | "induction" | "electric";
  kidsCount: number;
  pickyEaterCount: number;
  pickyAvoidances: string[];
  spiceTolerance: "mild" | "medium" | "hot" | "very_hot";
  healthGoals: string[];
  budgetLevel: "economy" | "mid_range" | "premium";
  expandedSections: Set<SectionId>;
};

export default function OnboardingStep3() {
  const router = useRouter();
  const {
    updateUserPreferences,
    completeOnboarding,
    onboardingStep2Draft,
    onboardingStep3Draft,
    setOnboardingStep3Draft,
  } = useApp();

  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const [form, setForm] = useState<Step3FormState>(() => {
    if (onboardingStep3Draft) {
      return {
        cookingEquipment: onboardingStep3Draft.cookingEquipment,
        stovetopType: onboardingStep3Draft.stovetopType,
        kidsCount: onboardingStep3Draft.kidsCount,
        pickyEaterCount: onboardingStep3Draft.pickyEaterCount,
        pickyAvoidances: onboardingStep3Draft.pickyAvoidances,
        spiceTolerance: onboardingStep3Draft.spiceTolerance,
        healthGoals: onboardingStep3Draft.healthGoals,
        budgetLevel: onboardingStep3Draft.budgetLevel,
        expandedSections: new Set(
          onboardingStep3Draft.expandedSections as SectionId[],
        ),
      };
    }
    return {
      cookingEquipment: [],
      stovetopType: undefined,
      kidsCount: 0,
      pickyEaterCount: 0,
      pickyAvoidances: [],
      spiceTolerance: "mild",
      healthGoals: [],
      budgetLevel: "economy",
      expandedSections: new Set<SectionId>(),
    };
  });

  const toggleSection = (id: SectionId) => {
    setForm((prev) => {
      const next = new Set(prev.expandedSections);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, expandedSections: next };
    });
  };

  const update = <K extends keyof Step3FormState>(
    key: K,
    value: Step3FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // WS7-2-E Bug 3: build a TRUE PARTIAL PATCH body from the user's actual
  // onboarding entries only — step-3 form ∪ step-2 draft. The earlier
  // version seeded from the getCurrentUserPreferences() stub, sending
  // fictional values for fields the user never touched (stub-base
  // pollution); on re-login the preferences screen surfaced those stub
  // values as if the user had set them.
  //
  // Four §14.9.2 fields — householdSize, wantsLeftovers, planLengthDefault,
  // defaultRetailer — are deliberately omitted: the current onboarding UI
  // does not collect them, so the server's DB defaults / nullability apply.
  // Adding onboarding UI for those fields is WS7-2-F (D-WS7-029).
  const buildFullPrefs = (): Partial<UserPreferencesData> => {
    const prefs: Partial<UserPreferencesData> = {
      // §3.5 — step-3 form values (this screen).
      cookingEquipment: form.cookingEquipment,
      kidsCount: form.kidsCount,
      pickyEaterCount: form.pickyEaterCount,
      pickyAvoidances: form.pickyAvoidances,
      spiceTolerance: form.spiceTolerance,
      healthGoals: form.healthGoals,
      budgetLevel: form.budgetLevel,
    };
    // stovetopType is optional — only send it when the user picked one.
    if (form.stovetopType) {
      prefs.stovetopType = form.stovetopType;
    }
    // §3.4 — step-2 draft values, only when the user actually visited step 2.
    if (onboardingStep2Draft) {
      prefs.cuisines = onboardingStep2Draft.cuisines;
      prefs.eatingStyles = onboardingStep2Draft.eatingStyles;
      prefs.allergiesAndAvoidances = onboardingStep2Draft.allergiesAndAvoidances;
      prefs.cookingSkill = onboardingStep2Draft.cookingSkill;
      prefs.recurringGroceryItems = onboardingStep2Draft.recurringGroceryItems;
      // dietaryNotes: include only when non-empty. Step 2 saves "" when the
      // user leaves the field blank; an empty string is not a meaningful
      // preference, so omit the key rather than PATCH a blank value.
      if (onboardingStep2Draft.dietaryNotes.length > 0) {
        prefs.dietaryNotes = onboardingStep2Draft.dietaryNotes;
      }
    }
    return prefs;
  };

  const persistDraft = () => {
    setOnboardingStep3Draft({
      cookingEquipment: form.cookingEquipment,
      stovetopType: form.stovetopType,
      kidsCount: form.kidsCount,
      pickyEaterCount: form.pickyEaterCount,
      pickyAvoidances: form.pickyAvoidances,
      spiceTolerance: form.spiceTolerance,
      healthGoals: form.healthGoals,
      budgetLevel: form.budgetLevel,
      expandedSections: Array.from(form.expandedSections),
    });
  };

  // D-WS6-019: PRD §3.5 specifies a dual-destination CTA on this screen
  // ("Get Kitchen Wizard Plans" + "Finish setup"). The wizard-jump path is
  // deferred — wiring it requires plan-level prefs (planDurationDays,
  // householdSize, wantsLeftovers) that this screen doesn't collect, so it
  // would have to either route through /wizard for those (a UX detour) or
  // inject defaults server-side. Until that's plumbed, "Finish setup" lands
  // on /first-run-destination, where the user picks their next step.
  //
  // WS7-2 Block C (D-WS7-011 + D-WS5-024): finish now persists preferences
  // AND flips the server-side onboardingComplete flag before navigating, so
  // an app-kill mid-onboarding no longer loses the flow. On error we surface
  // a message and do NOT navigate — the user can retry.
  const handleFinish = async () => {
    if (finishing) return;
    setFinishError(null);
    setFinishing(true);
    try {
      persistDraft();
      await updateUserPreferences(buildFullPrefs());
      await completeOnboarding();
      router.dismissAll();
      router.replace("/first-run-destination");
    } catch {
      setFinishError("Couldn't finish setup. Please try again.");
      setFinishing(false);
    }
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
          isOpen={form.expandedSections.has("equipment")}
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
          isOpen={form.expandedSections.has("kids")}
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
          isOpen={form.expandedSections.has("picky")}
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
          isOpen={form.expandedSections.has("spice")}
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
          isOpen={form.expandedSections.has("health")}
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
          isOpen={form.expandedSections.has("budget")}
          onToggle={() => toggleSection("budget")}
        >
          <BudgetLevelPicker
            value={form.budgetLevel}
            onChange={(next) => update("budgetLevel", next)}
          />
        </CollapsibleSection>

        <View style={s.footer}>
          <Button
            label="Finish setup"
            variant="terra"
            loading={finishing}
            disabled={finishing}
            onPress={handleFinish}
          />
          {finishError ? (
            <Text style={s.footerError}>{finishError}</Text>
          ) : (
            <Text style={s.footerHint}>
              Save preferences and start using Kiwi
            </Text>
          )}
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
    backgroundColor: KPalette.bg.card,
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
  footerError: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    textAlign: "center",
  },
});
