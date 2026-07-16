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
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { WizardResumeInterstitial } from "@/components/WizardResumeInterstitial";
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
import type { WizardPreferencesInput } from "@/lib/types";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import {
  dismissWizardDraft,
  getWizardDraft,
  listWizardDrafts,
  type ListWizardDraftsResponse,
} from "@/lib/api/wizard";
import { loadJSON, saveJSON } from "@/lib/storage";
import {
  addDismissed,
  pruneDismissed,
  visibleDrafts as computeVisibleDrafts,
} from "@/lib/wizard/dismissedDrafts";

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

// BUG-023 (WS9 3c) — per-device persisted set of resume-draft ids the user has
// dismissed ("Get new results"). Persisting it means a dismissed draft stays
// dismissed across wizard remounts, so the "pick up where you left off?"
// interstitial can't resurface a plan the user already moved past. Transient,
// per-device, self-cleaning (the draft's server TTL is the real cleanup; we
// also prune ids the server has already swept). Ruling 4 chose this over a
// server sweep — that literal supersede rides with BUG-030.
const DISMISSED_DRAFTS_KEY = "wizardDismissedDrafts";

interface WizardFormState {
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  eatingStyles: string[];
  allergies: string[];
  dietaryNotes: string;
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
  const queryClient = useQueryClient();
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
  // Cookbook Phase B Block 4 — stored prefs hydrate the wizard controls
  // (D-WS7-035). Read-only here: the wizard never PATCHes /me/preferences.
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
  });
  const [interstitialDismissed, setInterstitialDismissed] = useState(false);
  const [resumePendingDraftId, setResumePendingDraftId] = useState<
    string | null
  >(null);
  const [resumeErrorMessage, setResumeErrorMessage] = useState<string | null>(
    null,
  );

  // BUG-023 — load the persisted dismissed-draft set once on mount. `loaded`
  // gates the interstitial so it can't flash before we know which drafts the
  // user already dismissed.
  const [dismissedDraftIds, setDismissedDraftIds] = useState<string[]>([]);
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    loadJSON<string[]>(DISMISSED_DRAFTS_KEY, []).then((ids) => {
      if (active) {
        setDismissedDraftIds(ids);
        setDismissedLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

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

  // BUG-023 — keep the persisted dismissed set bounded: once the drafts list
  // loads, drop any dismissed id the server has already swept (past TTL /
  // activated). Guarded by the length check so it converges (no set → no
  // re-run) and only runs when there's a list to compare against.
  useEffect(() => {
    if (!dismissedLoaded) return;
    const draftIds = draftsQuery.data?.drafts.map((d) => d.id);
    if (!draftIds || draftIds.length === 0) return;
    const pruned = pruneDismissed(dismissedDraftIds, draftIds);
    if (pruned !== dismissedDraftIds) {
      setDismissedDraftIds(pruned);
      void saveJSON(DISMISSED_DRAFTS_KEY, pruned);
    }
  }, [dismissedLoaded, draftsQuery.data, dismissedDraftIds]);

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
    const payload: WizardPreferencesInput = {
      planDurationDays: form.planDurationDays,
      householdSize: form.householdSize,
      cuisines: form.cuisines,
      eatingStyles: form.eatingStyles,
      allergiesAndAvoidances: form.allergies,
      difficulty: form.difficulty,
      weeklyPacing: form.weeklyPacing,
      dietaryNotes: form.dietaryNotes.trim() || undefined,
      additionalNotes: form.additionalNotes.trim() || undefined,
      // Only send the four per-run overrides once stored prefs have hydrated
      // the controls. Sending pre-hydration defaults would override the user's
      // real stored prefs with wizard defaults (D-WS7-035 resolver precedence).
      ...(hydrated
        ? {
            discoveryMealsPerWeek: form.discoveryMealsPerWeek,
            saucePreference: form.saucePreference,
            maxCookTimeMinutes: form.maxCookTimeMinutes,
            maxCookTimeCoverage: form.maxCookTimeCoverage,
          }
        : {}),
    };
    console.log("[wizard] submit", payload);
    // WS6 6a-3 — payload travels to wizard-results as a JSON-encoded route
    // param; that screen calls POST /api/wizard/build-plans on mount.
    router.push({
      pathname: "/wizard-results",
      params: { input: JSON.stringify(payload) },
    });
  };

  const cuisineSelectedCount = form.cuisines.length;

  // ── interstitial gate ────────────────────────────────────────────────
  // Show a short loader while the drafts list AND stored prefs are in flight
  // so the inputs don't flash unhydrated before the interstitial can take
  // over. On either query's error we fall through — both are assists, not
  // blockers (the form renders with defaults if prefs fail to load).
  if (draftsQuery.isLoading || prefsQuery.isLoading || !dismissedLoaded) {
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
  const drafts = draftsQuery.data?.drafts ?? [];
  // BUG-023 — hide drafts the user already dismissed on a prior entry. Only the
  // never-dismissed drafts can surface the interstitial; a superseded plan
  // stays gone.
  const visibleDrafts = computeVisibleDrafts(drafts, dismissedDraftIds);
  if (!interstitialDismissed && visibleDrafts.length > 0) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Kitchen Wizard" />
        <WizardResumeInterstitial
          drafts={visibleDrafts}
          onResume={handleResume}
          onDismiss={() => {
            // "Get new results" declines these specific drafts. BUG-023 fix:
            // archive them SERVER-SIDE so they can't resurface on another
            // device or after a cache clear — the durable fix. The client set
            // + AsyncStorage stay as an OPTIMISTIC hide (no flash before the
            // server round-trip + refetch land). New drafts made later aren't
            // in the set / stay unarchived, so they can still resume.
            const dismissedIds = visibleDrafts.map((d) => d.id);
            const next = addDismissed(dismissedDraftIds, dismissedIds);
            setDismissedDraftIds(next);
            void saveJSON(DISMISSED_DRAFTS_KEY, next);
            setInterstitialDismissed(true);
            setResumeErrorMessage(null);
            // Fire-and-forget the server archive for each declined draft, then
            // refresh the list. Failures are non-fatal — the optimistic client
            // hide already covers this session; a surviving server row is
            // caught on the next dismiss or by the TTL sweep.
            void (async () => {
              await Promise.allSettled(
                dismissedIds.map((id) => dismissWizardDraft(id)),
              );
              void queryClient.invalidateQueries({
                queryKey: ["wizard", "drafts"],
              });
            })();
          }}
          resumePendingDraftId={resumePendingDraftId}
          resumeErrorMessage={resumeErrorMessage}
        />
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
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
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
                placeholder="e.g., 'no cilantro', 'lower sodium'"
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
            placeholderTextColor={Colors.neutral[600]}
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
