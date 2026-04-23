import React, { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getMondayISO } from "@/lib/domain";
import type { MealPlan } from "@/lib/types";
import { newId } from "@/lib/storage";
import { generatePlan } from "@/lib/api";

const NIGHT_OPTIONS = [3, 4, 5, 6, 7];
const TIME_OPTIONS = ["Quick (15-25m)", "Medium (25-40m)", "Long (40m+)"];
const STYLE_OPTIONS = [
  "Comfort food",
  "Light & fresh",
  "Hearty bowls",
  "Global flavors",
];

const STEPS = ["nights", "time", "style", "notes"] as const;

export default function Wizard() {
  const router = useRouter();
  const { savePlan, prefs, pantry } = useApp();

  const [stepIdx, setStepIdx] = useState(0);
  const [nights, setNights] = useState(5);
  const [time, setTime] = useState(TIME_OPTIONS[0]);
  const [styles_, setStyles] = useState<string[]>([STYLE_OPTIONS[0]]);
  const [budgetNote, setBudgetNote] = useState("");
  const [building, setBuilding] = useState(false);

  const toggleStyle = (s: string) =>
    setStyles((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );

  const next = () => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));
  const prev = () => setStepIdx((i) => Math.max(0, i - 1));

  const buildPrompt = () =>
    [
      `${nights} dinner nights`,
      time.toLowerCase(),
      `style: ${styles_.join(", ").toLowerCase() || "balanced"}`,
      budgetNote.trim() ? `notes: ${budgetNote.trim()}` : "",
    ]
      .filter(Boolean)
      .join(". ");

  const handleBuild = async () => {
    setBuilding(true);
    try {
      const result = await generatePlan({
        prompt: buildPrompt(),
        nights,
        prefs,
        pantry,
      });
      const plan: MealPlan = {
        id: newId(),
        name: result.name || `${nights}-night plan`,
        notes: result.notes,
        createdAt: Date.now(),
        weekStart: getMondayISO(),
        meals: result.meals,
      };
      await savePlan(plan);
      router.replace({ pathname: "/plan-results", params: { id: plan.id } });
    } catch (err: any) {
      Alert.alert(
        "Couldn't reach Kiwi",
        err?.message ||
          "Plan generation failed. Please try again in a moment.",
      );
    } finally {
      setBuilding(false);
    }
  };

  const stepLabel = STEPS[stepIdx];
  const isLast = stepIdx === STEPS.length - 1;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        title="Kitchen Wizard"
        subtitle={`Step ${stepIdx + 1} of ${STEPS.length}`}
        showBack
      />
      <View style={s.progressBar}>
        <View
          style={[
            s.progressFill,
            { width: `${((stepIdx + 1) / STEPS.length) * 100}%` },
          ]}
        />
      </View>
      <Screen>
        {stepLabel === "nights" && (
          <Section
            title="How many cooking nights?"
            subtitle="We'll plan exactly that many dinners."
          >
            <View style={s.chipRow}>
              {NIGHT_OPTIONS.map((n) => (
                <Chip
                  key={n}
                  label={`${n} nights`}
                  selected={nights === n}
                  onPress={() => setNights(n)}
                />
              ))}
            </View>
          </Section>
        )}

        {stepLabel === "time" && (
          <Section
            title="How much time per meal?"
            subtitle="Kiwi will favor recipes that fit."
          >
            <View style={s.chipRow}>
              {TIME_OPTIONS.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  selected={time === t}
                  onPress={() => setTime(t)}
                />
              ))}
            </View>
          </Section>
        )}

        {stepLabel === "style" && (
          <Section
            title="What style this week?"
            subtitle="Pick one or more."
          >
            <View style={s.chipRow}>
              {STYLE_OPTIONS.map((opt) => (
                <Chip
                  key={opt}
                  label={opt}
                  selected={styles_.includes(opt)}
                  onPress={() => toggleStyle(opt)}
                />
              ))}
            </View>
          </Section>
        )}

        {stepLabel === "notes" && (
          <Section
            title="Anything to keep in mind?"
            subtitle="Optional — Kiwi will read this."
          >
            <TextInput
              value={budgetNote}
              onChangeText={setBudgetNote}
              placeholder="e.g. budget-friendly, kid-approved, lots of leftovers"
              placeholderTextColor={KColors.neutral[600]}
              multiline
              style={s.input}
            />
          </Section>
        )}

        <View style={s.summaryCard}>
          <Text style={s.summaryLabel}>Building for</Text>
          <Text style={s.summaryText}>
            {prefs.household} {prefs.household === 1 ? "person" : "people"}
            {prefs.diet.length > 0 ? ` · ${prefs.diet.join(", ")}` : ""}
            {prefs.allergies.length > 0
              ? ` · avoiding ${prefs.allergies.join(", ")}`
              : ""}
            {pantry.length > 0 ? ` · ${pantry.length} pantry items` : ""}
          </Text>
        </View>

        <View style={{ height: KSpacing.xl }} />

        <View style={s.navRow}>
          {stepIdx > 0 && (
            <Button
              label="Back"
              variant="ghost"
              onPress={prev}
              fullWidth={false}
              iconLeft={
                <Feather name="chevron-left" size={16} color={KColors.sage[700]} />
              }
              style={{ flex: 1 }}
            />
          )}
          {isLast ? (
            <Button
              label={building ? "Kiwi is thinking…" : "Build my plan"}
              variant="terra"
              onPress={handleBuild}
              loading={building}
              style={{ flex: 1.5 }}
            />
          ) : (
            <Button
              label="Continue"
              variant="primary"
              onPress={next}
              style={{ flex: 1.5 }}
            />
          )}
        </View>
      </Screen>
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
    <View style={{ marginBottom: KSpacing.xl }}>
      <Text style={s.sectionTitle}>{title}</Text>
      {subtitle && <Text style={s.sectionSub}>{subtitle}</Text>}
      <View style={{ marginTop: KSpacing.md }}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  progressBar: {
    height: 3,
    backgroundColor: KColors.neutral[300],
  },
  progressFill: {
    height: "100%",
    backgroundColor: KColors.terracotta[400],
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sectionTitle: {
    fontSize: KType.size.xl,
    fontWeight: "700",
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  sectionSub: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    marginTop: 4,
    fontFamily: "Inter_400Regular",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    minHeight: 100,
    textAlignVertical: "top",
    fontFamily: "Inter_400Regular",
  },
  summaryCard: {
    padding: KSpacing.md,
    borderRadius: KRadius.lg,
    backgroundColor: KColors.neutral[200],
    borderColor: KColors.neutral[400],
    borderWidth: 1,
    marginTop: KSpacing.md,
  },
  summaryLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  summaryText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    marginTop: 4,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  navRow: {
    flexDirection: "row",
    gap: KSpacing.md,
  },
});
