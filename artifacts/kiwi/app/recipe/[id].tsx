import React from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/mockData";

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const recipe = id ? getRecipe(id) : undefined;

  if (!recipe) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Recipe" showBack />
        <Text style={s.notFound}>Recipe not found.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title={recipe.title} subtitle={recipe.cuisine} showBack />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        showsVerticalScrollIndicator={false}
      >
        <Image source={recipe.image} style={s.hero} />

        <View style={s.body}>
          <View style={s.metaRow}>
            <Meta icon="clock" value={`${recipe.minutes}m`} />
            <Meta icon="users" value={`${recipe.servings} servings`} />
            <Meta icon="zap" value={`${recipe.calories} cal`} />
          </View>

          <View style={s.macroBox}>
            <Macro label="Protein" value={`${recipe.protein}g`} />
            <Macro label="Carbs" value={`${recipe.carbs}g`} />
            <Macro label="Fat" value={`${recipe.fat}g`} />
          </View>

          <Text style={s.section}>Ingredients</Text>
          <View style={s.list}>
            {recipe.ingredients.map((ing) => (
              <View key={ing.name} style={s.ingRow}>
                <Text style={s.ingDot}>•</Text>
                <Text style={s.ingName}>{ing.name}</Text>
                <Text style={s.ingAmount}>{ing.amount}</Text>
              </View>
            ))}
          </View>

          <Text style={s.section}>Steps</Text>
          <View style={{ gap: KSpacing.md }}>
            {recipe.steps.map((step, i) => (
              <View key={i} style={s.stepRow}>
                <View style={s.stepNum}>
                  <Text style={s.stepNumText}>{i + 1}</Text>
                </View>
                <Text style={s.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      <View
        style={[
          s.footer,
          { paddingBottom: Math.max(insets.bottom, KSpacing.md) + KSpacing.md },
        ]}
      >
        <Button
          label="Start Cook Mode"
          variant="terra"
          onPress={() => router.push(`/cookmode/${recipe.id}`)}
          iconLeft={<Feather name="play" size={16} color="#fff" />}
        />
      </View>
    </View>
  );
}

function Meta({
  icon,
  value,
}: {
  icon: keyof typeof Feather.glyphMap;
  value: string;
}) {
  return (
    <View style={s.meta}>
      <Feather name={icon} size={14} color={KColors.sage[700]} />
      <Text style={s.metaText}>{value}</Text>
    </View>
  );
}

function Macro({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.macroItem}>
      <Text style={s.macroValue}>{value}</Text>
      <Text style={s.macroLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  hero: { width: "100%", height: 240, backgroundColor: KColors.neutral[200] },
  body: { padding: KSpacing.lg },
  metaRow: { flexDirection: "row", gap: KSpacing.lg, marginBottom: KSpacing.lg },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
  },
  macroBox: {
    flexDirection: "row",
    backgroundColor: "#f8faf6",
    borderColor: "#e0e8d8",
    borderWidth: 1,
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
  },
  macroItem: { flex: 1, alignItems: "center" },
  macroValue: {
    fontSize: KType.size.lg,
    fontWeight: "700",
    color: KColors.sage[700],
    fontFamily: "Inter_700Bold",
  },
  macroLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  section: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    marginTop: KSpacing.xxl,
    marginBottom: KSpacing.md,
    fontFamily: "Inter_600SemiBold",
  },
  list: { gap: KSpacing.sm },
  ingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  ingDot: { color: KColors.sage[600], fontSize: 16 },
  ingName: {
    flex: 1,
    color: KColors.neutral[900],
    fontSize: KType.size.md,
    fontFamily: "Inter_400Regular",
  },
  ingAmount: {
    color: KColors.neutral[700],
    fontSize: KType.size.sm,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  stepRow: { flexDirection: "row", gap: KSpacing.md, alignItems: "flex-start" },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: KColors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
  },
  stepText: {
    flex: 1,
    color: KColors.neutral[900],
    fontSize: KType.size.md,
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: KColors.neutral[100],
    borderTopWidth: 1,
    borderTopColor: KColors.neutral[400],
    padding: KSpacing.lg,
  },
  notFound: {
    color: KColors.neutral[700],
    textAlign: "center",
    marginTop: 80,
    fontFamily: "Inter_400Regular",
  },
});
