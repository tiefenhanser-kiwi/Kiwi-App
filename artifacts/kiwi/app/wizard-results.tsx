import React, { useMemo, useState } from "react";
import {
  Alert,
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
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getWizardPlanCandidates } from "@/lib/stubs";
import type { WizardPlanCandidate } from "@/lib/types";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function WizardResultsScreen() {
  const router = useRouter();
  // PRD §6.5/§6.6 — Tell Kiwi reuses this screen with adapted subtitle copy.
  const { source } = useLocalSearchParams<{ source?: "tellkiwi" }>();
  const candidates = useMemo(() => getWizardPlanCandidates(), []);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const subtitle =
    source === "tellkiwi"
      ? "3 plans Kiwi built from your request"
      : "3 plans Kiwi cooked up just for you";

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
    router.back();
  };

  const handleMoreOptions = () => {
    Alert.alert(
      "Coming in WS6 — AI orchestration",
      "Generating fresh plan options requires the AI layer. This will be wired in WS6.",
    );
  };

  const handleUsePlan = (candidateId: string) => {
    console.log("[wizard-results] use-this-plan picked", { candidateId });
    // PRD §11.4: land on the new plan's review page. WS5 stub uses the
    // shared "demo-plan-just-created" id so getReviewPlan returns the
    // empty-plan shape; WS7 will substitute the real id from the
    // plan-creation API response.
    router.replace({
      pathname: "/plan/[id]",
      params: { id: "demo-plan-just-created" },
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        showBack
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
            />
          </View>
        </View>

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
  card: {
    backgroundColor: KColors.neutral[0],
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
