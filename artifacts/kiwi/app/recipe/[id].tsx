import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/stubs";
import { scaleIngredients, type ScaleIngredient } from "@/lib/api";

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const recipe = id ? getRecipe(id) : undefined;
  const { isFavorite, toggleFavorite } = useApp();

  const [servings, setServings] = useState(recipe?.servings ?? 2);
  const [scaled, setScaled] = useState<ScaleIngredient[] | null>(null);
  const [loading, setLoading] = useState(false);
  const reqSeq = useRef(0);

  if (!recipe) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Recipe" showBack />
        <Text style={s.notFound}>Recipe not found.</Text>
      </View>
    );
  }

  const fav = isFavorite(recipe.id);
  const ingredientsToShow = scaled ?? recipe.ingredients;

  const requestScale = async (next: number) => {
    setServings(next);
    if (next === recipe.servings) {
      // Cancel any in-flight scaling and reset to the original list.
      reqSeq.current += 1;
      setScaled(null);
      setLoading(false);
      return;
    }
    const myReq = ++reqSeq.current;
    setLoading(true);
    try {
      const result = await scaleIngredients({
        recipeTitle: recipe.title,
        fromServings: recipe.servings,
        toServings: next,
        ingredients: recipe.ingredients,
      });
      // Ignore stale responses — only the latest request wins.
      if (myReq !== reqSeq.current) return;
      setScaled(result);
      Haptics.selectionAsync().catch(() => {});
    } catch (err) {
      if (myReq !== reqSeq.current) return;
      Alert.alert(
        "Couldn't scale",
        "Kiwi couldn't reach the scaler right now. Showing the original amounts.",
      );
      setScaled(null);
      setServings(recipe.servings);
    } finally {
      if (myReq === reqSeq.current) setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        title={recipe.title}
        subtitle={recipe.cuisine}
        showBack
        rightIcon="heart"
        onRightPress={async () => {
          await toggleFavorite(recipe.id);
          Haptics.selectionAsync().catch(() => {});
        }}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Image source={recipe.image} style={s.hero} />
          {fav && (
            <View style={s.favBadge}>
              <Feather name="heart" size={12} color="#fff" />
              <Text style={s.favBadgeText}>Favorite</Text>
            </View>
          )}
        </View>

        <View style={s.body}>
          <View style={s.metaRow}>
            <Meta icon="clock" value={`${recipe.minutes}m`} />
            <Meta icon="users" value={`${servings} servings`} />
            <Meta icon="zap" value={`${recipe.calories} cal`} />
          </View>

          <View style={s.macroBox}>
            <Macro label="Protein" value={`${recipe.protein}g`} />
            <Macro label="Carbs" value={`${recipe.carbs}g`} />
            <Macro label="Fat" value={`${recipe.fat}g`} />
          </View>

          <View style={s.scaleCard}>
            <View style={{ flex: 1 }}>
              <Text style={s.scaleTitle}>Scale ingredients</Text>
              <Text style={s.scaleBody}>
                {scaled
                  ? `Adjusted for ${servings} servings`
                  : `Original recipe serves ${recipe.servings}`}
              </Text>
            </View>
            <View style={s.stepper}>
              <Pressable
                onPress={() => requestScale(Math.max(1, servings - 1))}
                disabled={loading || servings <= 1}
                style={s.stepBtn}
                hitSlop={6}
              >
                <Feather name="minus" size={16} color={KColors.sage[700]} />
              </Pressable>
              <Text style={s.stepValue}>{servings}</Text>
              <Pressable
                onPress={() => requestScale(Math.min(12, servings + 1))}
                disabled={loading || servings >= 12}
                style={s.stepBtn}
                hitSlop={6}
              >
                <Feather name="plus" size={16} color={KColors.sage[700]} />
              </Pressable>
            </View>
          </View>

          <View style={s.sectionRow}>
            <Text style={s.section}>Ingredients</Text>
            {loading && (
              <ActivityIndicator size="small" color={KColors.sage[700]} />
            )}
          </View>
          <View style={s.list}>
            {ingredientsToShow.map((ing) => (
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
  favBadge: {
    position: "absolute",
    top: KSpacing.md,
    left: KSpacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: KColors.terracotta[400],
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  favBadgeText: {
    color: "#fff",
    fontSize: KType.size.xs,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
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
  scaleCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    marginTop: KSpacing.lg,
    backgroundColor: KColors.neutral[0],
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
  },
  scaleTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  scaleBody: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[200],
    borderRadius: 999,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  stepBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: KColors.neutral[0],
    alignItems: "center",
    justifyContent: "center",
  },
  stepValue: {
    minWidth: 18,
    textAlign: "center",
    fontSize: KType.size.md,
    fontWeight: "700",
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: KSpacing.xxl,
    marginBottom: KSpacing.md,
  },
  section: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
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
