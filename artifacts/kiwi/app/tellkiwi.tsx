import React, { useState } from "react";
import {
  ActivityIndicator,
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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
        router.push({
          pathname: "/wizard-results",
          params: {
            source: "tellkiwi",
            tellKiwiResult: JSON.stringify(result),
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
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
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
          <View style={{ marginTop: KSpacing.md }}>
            <TextInput
              value={form.description}
              onChangeText={(v) =>
                update("description", v.slice(0, DESCRIPTION_MAX))
              }
              placeholder={PLACEHOLDER}
              placeholderTextColor={KColors.neutral[600]}
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
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
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
                placeholder="e.g., 'no shellfish', 'low sodium'"
                placeholderTextColor={KColors.neutral[600]}
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
              <View style={{ marginTop: KSpacing.sm }}>
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
            variant="terra"
            onPress={handleSubmit}
            disabled={mutation.isPending}
          />
          {mutation.isPending && (
            <View style={s.thinkingRow}>
              <ActivityIndicator size="small" color={KColors.sage[700]} />
              <Text style={s.footerHint}>Reading what you wrote…</Text>
            </View>
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
  descriptionInput: {
    minHeight: 110,
    maxHeight: 220,
    paddingVertical: KSpacing.md,
    lineHeight: 22,
  },
  charCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.xs,
    textAlign: "right",
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
  noticeCard: {
    backgroundColor: KColors.terracotta[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.terracotta[300],
    padding: KSpacing.md,
    marginTop: KSpacing.md,
  },
  noticeTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  noticeBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  clarifyCard: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    marginTop: KSpacing.md,
  },
  clarifyTitle: {
    fontSize: KType.size.md,
    color: KColors.sage[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  clarifyBody: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
});
