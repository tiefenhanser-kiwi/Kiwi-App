import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { defaultPlan, RECIPES } from "@/lib/mockData";
import { newId } from "@/lib/storage";

const NIGHT_OPTIONS = [3, 4, 5, 6, 7];
const TIME_OPTIONS = ["Quick (15-25m)", "Medium (25-40m)", "Long (40m+)"];
const STYLE_OPTIONS = ["Comfort food", "Light & fresh", "Hearty bowls", "Global flavors"];

export default function Wizard() {
  const router = useRouter();
  const { savePlan, prefs } = useApp();

  const [nights, setNights] = useState(5);
  const [time, setTime] = useState(TIME_OPTIONS[0]);
  const [styles_, setStyles] = useState<string[]>([STYLE_OPTIONS[0]]);
  const [budgetNote, setBudgetNote] = useState("");
  const [building, setBuilding] = useState(false);

  const toggleStyle = (s: string) =>
    setStyles((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const handleBuild = async () => {
    setBuilding(true);
    // Day-1 stub: deterministic plan from local recipes.
    // When the Anthropic key arrives, swap in a /api/plans/generate call here.
    const plan = defaultPlan();
    plan.id = newId();
    plan.name = `${nights}-night plan`;
    plan.meals = plan.meals.slice(0, nights).map((m, i) => ({
      ...m,
      recipeId: RECIPES[i % RECIPES.length].id,
    }));
    await savePlan(plan);
    setBuilding(false);
    router.replace({ pathname: "/plan-results", params: { id: plan.id } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Kitchen Wizard" subtitle="Tell Kiwi what you need" showBack />
      <Screen>
        <Section title="How many cooking nights?">
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

        <Section title="How much time per meal?">
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

        <Section title="What style this week?">
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

        <Section title="Anything to keep in mind?" subtitle="Optional notes">
          <TextInput
            value={budgetNote}
            onChangeText={setBudgetNote}
            placeholder="e.g. budget-friendly, kid-approved, lots of leftovers"
            placeholderTextColor={KColors.neutral[600]}
            multiline
            style={s.input}
          />
        </Section>

        <View style={s.summaryCard}>
          <Text style={s.summaryLabel}>Building for</Text>
          <Text style={s.summaryText}>
            {prefs.household} {prefs.household === 1 ? "person" : "people"}
            {prefs.diet.length > 0 ? ` · ${prefs.diet.join(", ")}` : ""}
            {prefs.allergies.length > 0
              ? ` · avoiding ${prefs.allergies.join(", ")}`
              : ""}
          </Text>
        </View>

        <View style={{ height: KSpacing.xl }} />
        <Button
          label={building ? "Kiwi is thinking…" : "Build my plan"}
          variant="terra"
          onPress={handleBuild}
          loading={building}
        />
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
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sectionTitle: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  sectionSub: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
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
    minHeight: 80,
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
});
