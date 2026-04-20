import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { KColors, KRadius, KShadow, KSpacing, KType } from "@/constants/tokens";
import { Recipe } from "@/lib/mockData";

interface Props {
  recipe: Recipe;
  day?: string;
  slot?: string;
  onPress?: () => void;
}

export function MealCard({ recipe, day, slot, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, { opacity: pressed ? 0.92 : 1 }]}
    >
      <Image source={recipe.image} style={styles.image} />
      <View style={styles.body}>
        {(day || slot) && (
          <Text style={styles.day}>
            {day}
            {day && slot ? " · " : ""}
            {slot}
          </Text>
        )}
        <Text style={styles.title} numberOfLines={1}>
          {recipe.title}
        </Text>
        <View style={styles.metaRow}>
          <View style={styles.meta}>
            <Feather name="clock" size={12} color={KColors.neutral[700]} />
            <Text style={styles.metaText}>{recipe.minutes}m</Text>
          </View>
          <View style={styles.meta}>
            <Feather name="users" size={12} color={KColors.neutral[700]} />
            <Text style={styles.metaText}>{recipe.servings}</Text>
          </View>
          <View style={styles.meta}>
            <Feather name="zap" size={12} color={KColors.neutral[700]} />
            <Text style={styles.metaText}>{recipe.calories} cal</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.xl,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    overflow: "hidden",
    ...KShadow.card,
  },
  image: {
    width: "100%",
    height: 160,
    backgroundColor: KColors.neutral[200],
  },
  body: { padding: KSpacing.lg, gap: 6 },
  day: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  title: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  metaRow: {
    flexDirection: "row",
    gap: KSpacing.lg,
    marginTop: 4,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
});
