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
import { LoadingShim } from "@/components/LoadingShim";
import { Stepper } from "@/components/Stepper";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  ALLERGIES_AND_AVOIDANCES,
  EATING_STYLES,
} from "@/lib/domain";
import type { TellKiwiInput } from "@/lib/types";
import { useBuildFromText } from "@/hooks/useBuildFromText";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const DESCRIPTION_MAX = 500;
const DESCRIPTION_MIN = 5;

const PLACEHOLDER =
  "Describe what you'd like for the week. Examples: 'Comforting weeknight meals for a family of 4', 'Italian and Mediterranean only', 'burgers, mac and cheese, grilled chicken, soup, and pasta', or 'Easy meals my picky kids will eat plus one fancy night'";

interface TellKiwiFormState {
  description: string;
  householdSize: number;
  wantsLeftovers: boolean;
  dietExpanded: boolean;
  eatingStyles: Set<string>;
  allergiesExpanded: boolean;
  allergies: Set<string>;
  dietaryNotes: string;
}

const INITIAL_FORM: TellKiwiFormState = {
  description: "",
  householdSize: 4,
  wantsLeftovers: false,
  dietExpanded: false,
  eatingStyles: new Set(),
  allergiesExpanded: false,
  allergies: new Set(),
  dietaryNotes: "",
};

export default function TellKiwi() {
  const router = useRouter();
  const [form, setForm] = useState<TellKiwiFormState>(INITIAL_FORM);
  const mutation = useBuildFromText();

  const update = <K extends keyof TellKiwiFormState>(
    key: K,
    value: TellKiwiFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSetItem = (
    key: "eatingStyles" | "allergies",
    item: string,
  ) => {
    setForm((prev) => {
      const next = new Set(prev[key]);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return { ...prev, [key]: next };
    });
  };

  const buildPayload = (): TellKiwiInput => ({
    description: form.description.trim(),
    householdSize: form.householdSize,
    wantsLeftovers: form.wantsLeftovers,
    eatingStyles: Array.from(form.eatingStyles),
    allergiesAndAvoidances: Array.from(form.allergies),
    dietaryNotes: form.dietaryNotes.trim() || undefined,
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
        {/* Section 1: Free-text description */}
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
                false: Colors.neutral[400],
                true: Colors.sage[700],
              }}
              thumbColor={Colors.neutral[0]}
            />
          </View>
        </Section>

        {/* Section 4: Diet (collapsible) */}
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
              color={Colors.neutral[700]}
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

              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
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
                <View style={[s.chipRow, { marginTop: Spacing[2] }]}>
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
        color={Colors.sage[700]}
      />
    </Pressable>
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
  expandLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: Spacing[2],
    alignSelf: "flex-start",
  },
  expandLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
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
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
});
