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
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { WizardResumeInterstitial } from "@/components/WizardResumeInterstitial";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  ALLERGIES_AND_AVOIDANCES,
  CUISINES_TIER_1,
  CUISINES_TIER_2,
  EATING_STYLES,
  PLAN_DURATION_PRESETS,
} from "@/lib/domain";
import type { WizardPreferencesInput } from "@/lib/types";
import {
  getWizardDraft,
  listWizardDrafts,
  type ListWizardDraftsResponse,
} from "@/lib/api/wizard";

type Difficulty = WizardPreferencesInput["difficulty"];
type WeeklyPacing = WizardPreferencesInput["weeklyPacing"];

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
  wantsLeftovers: boolean;
  cuisines: Set<string>;
  cuisineExpanded: boolean;
  eatingStyles: Set<string>;
  dietExpanded: boolean;
  allergies: Set<string>;
  allergiesExpanded: boolean;
  dietaryNotes: string;
  /** Hidden from UI per WS5-5N-bis-fix-wizard-fix; kept on state so
   *  the payload still carries the field. */
  difficulty: Difficulty;
  weeklyPacing: WeeklyPacing;
  additionalNotes: string;
}

// TODO(WS5-5P + WS7): Wire from user's stored skill level per PRD §5.3
// — Beginner→Easy, Intermediate→Medium, Advanced→Fancy. Until Profile
// (5P) ships, hardcoded to "medium" and not surfaced in the wizard UI.
const HIDDEN_DEFAULT_DIFFICULTY: Difficulty = "medium";

const INITIAL_FORM: WizardFormState = {
  planDurationDays: 5,
  householdSize: 4,
  wantsLeftovers: false,
  cuisines: new Set(["American", "Mexican"]),
  cuisineExpanded: false,
  eatingStyles: new Set(),
  dietExpanded: false,
  allergies: new Set(),
  allergiesExpanded: false,
  dietaryNotes: "",
  difficulty: HIDDEN_DEFAULT_DIFFICULTY,
  weeklyPacing: "mostly_easy",
  additionalNotes: "",
};

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

  // WS7-5b-mobile Block B — wizard-entry resume interstitial.
  // Fetch unsaved drafts on mount. While the fetch is in flight we render a
  // small loader so the inputs don't flash before the interstitial can take
  // over. On error we fall through to inputs — the resume prompt is an
  // assist, not a blocker. `dismissed` is local-only (no persistence per
  // spec: "Get new results" is the implicit pass for this session only).
  const draftsQuery = useQuery<ListWizardDraftsResponse>({
    queryKey: ["wizard", "drafts"],
    queryFn: listWizardDrafts,
    staleTime: 0,
  });
  const [interstitialDismissed, setInterstitialDismissed] = useState(false);
  const [resumePendingDraftId, setResumePendingDraftId] = useState<
    string | null
  >(null);
  const [resumeErrorMessage, setResumeErrorMessage] = useState<string | null>(
    null,
  );

  const handleResume = async (draftId: string) => {
    if (resumePendingDraftId) return;
    setResumePendingDraftId(draftId);
    setResumeErrorMessage(null);
    try {
      const result = await getWizardDraft(draftId);
      router.push({
        pathname: "/wizard-plan-details",
        params: {
          draftId: result.draft.id,
          // Block A's screen consumes a JSON-stringified expanded payload —
          // same as POST /wizard/expand's flow, so resume reuses it verbatim.
          expanded: JSON.stringify(result.expanded),
        },
      });
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't load that draft.";
      setResumeErrorMessage(message);
    } finally {
      setResumePendingDraftId(null);
    }
  };

  const [form, setForm] = useState<WizardFormState>(INITIAL_FORM);

  const update = <K extends keyof WizardFormState>(
    key: K,
    value: WizardFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSetItem = (
    key: "cuisines" | "eatingStyles" | "allergies",
    item: string,
  ) => {
    setForm((prev) => {
      const next = new Set(prev[key]);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return { ...prev, [key]: next };
    });
  };

  const handleSelectDuration = (n: number) => {
    update("planDurationDays", n);
  };

  const handleSubmit = () => {
    Keyboard.dismiss();
    const payload: WizardPreferencesInput = {
      planDurationDays: form.planDurationDays,
      householdSize: form.householdSize,
      wantsLeftovers: form.wantsLeftovers,
      cuisines: Array.from(form.cuisines),
      eatingStyles: Array.from(form.eatingStyles),
      allergiesAndAvoidances: Array.from(form.allergies),
      difficulty: form.difficulty,
      weeklyPacing: form.weeklyPacing,
      dietaryNotes: form.dietaryNotes.trim() || undefined,
      additionalNotes: form.additionalNotes.trim() || undefined,
    };
    console.log("[wizard] submit", payload);
    // WS6 6a-3 — payload travels to wizard-results as a JSON-encoded route
    // param; that screen calls POST /api/wizard/build-plans on mount.
    router.push({
      pathname: "/wizard-results",
      params: { input: JSON.stringify(payload) },
    });
  };

  const cuisineSelectedCount = form.cuisines.size;

  // ── interstitial gate ────────────────────────────────────────────────
  // Show a short loader while the drafts list is in flight so the inputs
  // don't flash before the interstitial can take over. On query error we
  // fall through to inputs — the resume prompt is an assist, not a blocker.
  if (draftsQuery.isLoading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: KColors.neutral[100],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={KColors.sage[700]} />
      </View>
    );
  }
  const drafts = draftsQuery.data?.drafts ?? [];
  if (!interstitialDismissed && drafts.length > 0) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack title="Kitchen Wizard" />
        <WizardResumeInterstitial
          drafts={drafts}
          onResume={handleResume}
          onDismiss={() => {
            setInterstitialDismissed(true);
            setResumeErrorMessage(null);
          }}
          resumePendingDraftId={resumePendingDraftId}
          resumeErrorMessage={resumeErrorMessage}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        showBack
        title="Kitchen Wizard"
        subtitle="Set preferences"
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Plan duration */}
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

        {/* Section 2: Household size */}
        <Section label="Household" title="Cooking for">
          <Stepper
            value={form.householdSize}
            onChange={(n) => update("householdSize", n)}
            min={HOUSEHOLD_MIN}
            max={HOUSEHOLD_MAX}
            suffix={form.householdSize === 1 ? "person" : "people"}
          />
        </Section>

        {/* Section 3: Leftovers */}
        <Section label="Leftovers" title="Include leftovers">
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
        </Section>

        {/* Section 4: Cuisines */}
        <Section
          label="Cuisines"
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
                selected={form.cuisines.has(c)}
                onPress={() => toggleSetItem("cuisines", c)}
              />
            ))}
          </View>
          <ExpandLink
            expanded={form.cuisineExpanded}
            label="More cuisines"
            onPress={() =>
              update("cuisineExpanded", !form.cuisineExpanded)
            }
          />
          {form.cuisineExpanded && (
            <View style={[s.chipRow, { marginTop: KSpacing.sm }]}>
              {CUISINES_TIER_2.map((c) => (
                <Chip
                  key={c}
                  label={c}
                  selected={form.cuisines.has(c)}
                  onPress={() => toggleSetItem("cuisines", c)}
                />
              ))}
            </View>
          )}
        </Section>

        {/* Section 5: Weekly pacing — single-select chip cloud (auto-wrap). */}
        <Section label="Pacing" title="Weekly pacing">
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
        </Section>

        {/* Section 7: Diet (collapsible) */}
        <View style={s.card}>
          <Pressable
            onPress={() => update("dietExpanded", !form.dietExpanded)}
            style={({ pressed }) => [
              s.dietHeader,
              pressed && { opacity: 0.7 },
            ]}
            hitSlop={6}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>
                Dietary preferences & restrictions
              </Text>
              <Text style={s.cardSubtitle}>Optional</Text>
            </View>
            <Feather
              name={form.dietExpanded ? "chevron-up" : "chevron-down"}
              size={20}
              color={KColors.neutral[700]}
            />
          </Pressable>

          {form.dietExpanded && (
            <View style={s.dietBody}>
              <Text style={s.subSectionLabel}>Eating styles</Text>
              <View style={s.chipRow}>
                {EATING_STYLES.map((e) => (
                  <Chip
                    key={e}
                    label={e}
                    selected={form.eatingStyles.has(e)}
                    onPress={() => toggleSetItem("eatingStyles", e)}
                  />
                ))}
              </View>

              <Text style={[s.subSectionLabel, { marginTop: KSpacing.lg }]}>
                Allergies & avoidances
              </Text>
              <ExpandLink
                expanded={form.allergiesExpanded}
                label="More"
                onPress={() =>
                  update("allergiesExpanded", !form.allergiesExpanded)
                }
              />
              {form.allergiesExpanded && (
                <View style={[s.chipRow, { marginTop: KSpacing.sm }]}>
                  {ALLERGIES_AND_AVOIDANCES.map((a) => (
                    <Chip
                      key={a}
                      label={a}
                      selected={form.allergies.has(a)}
                      onPress={() => toggleSetItem("allergies", a)}
                    />
                  ))}
                </View>
              )}

              <Text style={[s.subSectionLabel, { marginTop: KSpacing.lg }]}>
                Anything else?
              </Text>
              <TextInput
                value={form.dietaryNotes}
                onChangeText={(v) => update("dietaryNotes", v)}
                placeholder="e.g., 'no cilantro', 'lower sodium'"
                placeholderTextColor={KColors.neutral[600]}
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={Keyboard.dismiss}
                style={s.input}
              />
            </View>
          )}
        </View>

        {/* Section 8: Optional free text */}
        <Section
          label="Notes"
          title="Anything specific for this plan?"
          subtitle="Optional"
        >
          <TextInput
            value={form.additionalNotes}
            onChangeText={(v) => update("additionalNotes", v)}
            placeholder="e.g., a comforting week, planning to entertain Saturday, lots of veggies"
            placeholderTextColor={KColors.neutral[600]}
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
            variant="terra"
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
      <View style={{ marginTop: KSpacing.md }}>{children}</View>
    </View>
  );
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
      style={({ pressed }) => [
        s.expandLink,
        pressed && { opacity: 0.6 },
      ]}
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
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  sectionLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
    marginBottom: 6,
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
  dietHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  dietBody: {
    marginTop: KSpacing.lg,
  },
  subSectionLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
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
