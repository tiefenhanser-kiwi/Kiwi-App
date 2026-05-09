import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useBuildWizardPlans } from "@/hooks/useBuildWizardPlans";
import type { WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function parseInput(raw: string | undefined): WizardPreferencesInput | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WizardPreferencesInput;
  } catch {
    return null;
  }
}

export default function WizardResultsScreen() {
  const router = useRouter();
  // PRD §6.5/§6.6 — Tell Kiwi reuses this screen with adapted subtitle copy.
  // Tell Kiwi entry-point still routes here without `input`; that path is
  // wired to its own AI flow in 6a-4. Until then, no-input → error state.
  const { source, input } = useLocalSearchParams<{
    source?: "tellkiwi" | "onboarding";
    input?: string;
  }>();
  const wizardInput = useMemo(() => parseInput(input), [input]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // `attempt` ticks once per regen request so the effect re-fires even when
  // `input` is identical (re-entering the wizard with unchanged prefs would
  // otherwise leave React Query showing the previous mount's data).
  const [attempt, setAttempt] = useState(0);
  const mutation = useBuildWizardPlans();

  useEffect(() => {
    if (!wizardInput) return;
    mutation.reset();
    mutation.mutate(wizardInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, attempt]);

  const subtitle =
    source === "tellkiwi"
      ? "3 plans Kiwi built from your request"
      : "3 plans Kiwi cooked up just for you";

  const candidates: WizardPlanCandidate[] = mutation.data?.candidates ?? [];

  const toggleExpanded = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRefine = () => {
    if (source === "onboarding") {
      router.replace("/onboarding-tellkiwi");
    } else {
      router.back();
    }
  };

  const handleMoreOptions = () => {
    if (!wizardInput) return;
    setExpandedIds(new Set());
    // Bump attempt; the effect handles reset+mutate so both navigation-driven
    // and button-driven re-rolls go through one code path.
    setAttempt((n) => n + 1);
  };

  const handleHeaderBack = () => {
    router.replace("/(tabs)");
  };

  const handleUsePlan = (candidateId: string) => {
    console.log("[wizard-results] use-this-plan picked", { candidateId });
    // push, not replace, so back-pop from the (WS7-pending) plan stub returns
    // here instead of skipping straight to the wizard preferences screen.
    router.push({
      pathname: "/plan/[id]",
      params: { id: "demo-plan-just-created" },
    });
  };

  // ── render branches ──────────────────────────────────────────────────

  // No input → entry-point not wired yet (e.g., Tell Kiwi pre-6a-4).
  if (!wizardInput) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack onBack={handleHeaderBack} title="Plan options" />
        <Screen>
          <View style={s.statusBox}>
            <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
            <Text style={s.errorBody}>
              Plan input wasn&apos;t passed through. Head back to the wizard
              and resubmit.
            </Text>
            <View style={{ marginTop: KSpacing.md }}>
              <Button
                label="Back to wizard"
                variant="primary"
                onPress={handleRefine}
              />
            </View>
          </View>
        </Screen>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        showBack
        onBack={handleHeaderBack}
        title="Plan options"
        subtitle={subtitle}
      />
      <Screen>
        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button
              label="Refine preferences"
              variant="ghost"
              onPress={handleRefine}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="More options ↺"
              variant="terra"
              onPress={handleMoreOptions}
              disabled={mutation.isPending}
            />
          </View>
        </View>

        {mutation.isPending && (
          <View style={s.statusBox}>
            <ActivityIndicator size="large" color={KColors.sage[700]} />
            <Text style={s.statusText}>Kiwi is thinking…</Text>
          </View>
        )}

        {!mutation.isPending && mutation.isError && (
          <View style={s.statusBox}>
            <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
            {mutation.error?.message ? (
              <Text style={s.errorBody}>{mutation.error.message}</Text>
            ) : null}
            <View style={{ marginTop: KSpacing.md }}>
              <Button
                label="Try again"
                variant="primary"
                onPress={handleMoreOptions}
              />
            </View>
          </View>
        )}

        {!mutation.isPending &&
          mutation.isSuccess &&
          mutation.data?.cannotGenerateMore && (
            <View style={s.noticeBox}>
              <Text style={s.noticeText}>
                {mutation.data.reason ??
                  "Kiwi couldn&apos;t produce 3 distinct plans for these constraints."}
              </Text>
            </View>
          )}

        {!mutation.isPending && mutation.isSuccess && (
          <View style={s.candidatesWrap}>
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                expanded={expandedIds.has(c.id)}
                onToggleExpanded={() => toggleExpanded(c.id)}
                onUsePlan={() => handleUsePlan(c.id)}
              />
            ))}
          </View>
        )}
      </Screen>
    </View>
  );
}

function CandidateCard({
  candidate,
  expanded,
  onToggleExpanded,
  onUsePlan,
}: {
  candidate: WizardPlanCandidate;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUsePlan: () => void;
}) {
  const macrosLine = `Avg ${candidate.dailyMacros.calories} cal/day · ${candidate.dailyMacros.proteinG}g P · ${candidate.dailyMacros.carbsG}g C · ${candidate.dailyMacros.fatG}g F`;

  return (
    <View style={s.card}>
      {/* Hero */}
      <View style={s.hero}>
        {candidate.imageUrl ? (
          <Image source={{ uri: candidate.imageUrl }} style={s.heroImage} />
        ) : (
          <View style={[s.heroImage, s.heroFallback]} />
        )}
        <View style={s.heroOverlay} />
        <View style={s.heroFooter}>
          {candidate.badge && (
            <View
              style={[
                s.badge,
                candidate.badge === "featured"
                  ? s.badgeFeatured
                  : s.badgeTopRated,
              ]}
            >
              <Text style={s.badgeText}>
                {candidate.badge === "featured" ? "Featured" : "Top Rated"}
              </Text>
            </View>
          )}
          <Text style={s.heroTitle} numberOfLines={2}>
            {candidate.title}
          </Text>
        </View>
      </View>

      {/* Body */}
      <View style={s.body}>
        <View style={s.tagRow}>
          {candidate.tags.map((t) => (
            <View key={t} style={s.tag}>
              <Text style={s.tagText}>{t}</Text>
            </View>
          ))}
        </View>

        <View style={s.whyBox}>
          <Text style={s.whyLabel}>WHY THIS WORKS</Text>
          {candidate.whyBullets.map((b, i) => (
            <View key={i} style={s.whyRow}>
              <View style={s.whyDot} />
              <Text style={s.whyText}>{b}</Text>
            </View>
          ))}
        </View>

        <Text style={s.macrosLine} numberOfLines={1} ellipsizeMode="tail">
          {macrosLine}
        </Text>

        <Pressable
          onPress={onToggleExpanded}
          hitSlop={6}
          style={({ pressed }) => [
            s.expandToggle,
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text style={s.expandToggleText}>
            {expanded ? "Hide preview" : "Preview meals & macros"}
          </Text>
          <Feather
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color={KColors.sage[700]}
          />
        </Pressable>

        {expanded && (
          <View style={s.expandedSection}>
            <Text style={s.subSectionLabel}>Meals in this plan</Text>
            <View style={s.mealList}>
              {candidate.mealTitles.map((title, i) => (
                <View key={i} style={s.mealRow}>
                  <View style={s.mealDot} />
                  <Text style={s.mealText}>{title}</Text>
                </View>
              ))}
            </View>

            <Text style={[s.subSectionLabel, { marginTop: KSpacing.lg }]}>
              Daily averages
            </Text>
            <View style={s.macrosGrid}>
              <MacroCell
                value={candidate.dailyMacros.calories}
                label="cal/day"
              />
              <MacroCell
                value={candidate.dailyMacros.proteinG}
                label="g protein"
              />
              <MacroCell
                value={candidate.dailyMacros.carbsG}
                label="g carbs"
              />
              <MacroCell
                value={candidate.dailyMacros.fatG}
                label="g fat"
              />
            </View>

            <View style={{ marginTop: KSpacing.lg }}>
              <Button
                label="Use this plan"
                variant="primary"
                onPress={onUsePlan}
              />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

function MacroCell({ value, label }: { value: number; label: string }) {
  return (
    <View style={s.macroCell}>
      <Text style={s.macroValue}>{value}</Text>
      <Text style={s.macroLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginBottom: KSpacing.md,
  },
  candidatesWrap: {
    gap: KSpacing.md,
  },
  statusBox: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
  },
  statusText: {
    fontSize: KType.size.md,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  errorTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  errorBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  noticeBox: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    marginBottom: KSpacing.md,
  },
  noticeText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontFamily: "Inter_400Regular",
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    overflow: "hidden",
  },
  hero: {
    height: 120,
    width: "100%",
    backgroundColor: KColors.sage[200],
    position: "relative",
  },
  heroImage: {
    width: "100%",
    height: "100%",
  },
  heroFallback: {
    backgroundColor: KColors.sage[200],
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.35)",
  },
  heroFooter: {
    position: "absolute",
    left: KSpacing.md,
    right: KSpacing.md,
    bottom: KSpacing.sm,
    gap: 6,
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 3,
    borderRadius: KRadius.pill,
  },
  badgeFeatured: {
    backgroundColor: KColors.terracotta[500],
  },
  badgeTopRated: {
    backgroundColor: KColors.sage[700],
  },
  badgeText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  heroTitle: {
    fontSize: KType.size.xl,
    color: KColors.neutral[0],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  body: {
    padding: KSpacing.md,
    gap: KSpacing.sm,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  tag: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 3,
    backgroundColor: KColors.neutral[100],
    borderRadius: KRadius.pill,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  tagText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  whyBox: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    gap: 6,
  },
  whyLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  whyRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "flex-start",
  },
  whyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: KColors.terracotta[400],
    marginTop: 7,
  },
  whyText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
  },
  macrosLine: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  expandToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  expandToggleText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  expandedSection: {
    paddingTop: KSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: KColors.neutral[300],
    marginTop: KSpacing.sm,
  },
  subSectionLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  mealList: {
    gap: KSpacing.xs,
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  mealDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: KColors.sage[600],
  },
  mealText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
  },
  macrosGrid: {
    flexDirection: "row",
    gap: KSpacing.xs,
  },
  macroCell: {
    flex: 1,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    paddingVertical: KSpacing.sm,
    alignItems: "center",
  },
  macroValue: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  macroLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    textAlign: "center",
  },
});
