import React from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { MealRowData } from "@/lib/stubs";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

type Props = {
  meal: MealRowData;
  onPress: () => void;
  onViewDetails: () => void;
  onCookNow: () => void;
};

export function MealRow({ meal, onPress, onViewDetails, onCookNow }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.thumb}>
        {meal.thumbnailUrl ? (
          <Image
            source={{ uri: meal.thumbnailUrl }}
            style={styles.thumbImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.thumbFallback} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {meal.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meal.meta}
        </Text>
        {meal.cuisineTag && (
          <View style={styles.tagRow}>
            <View style={styles.tag}>
              <Text style={styles.tagText}>{meal.cuisineTag}</Text>
            </View>
          </View>
        )}
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={onViewDetails}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.actionSecondary,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.actionTextSecondary}>View</Text>
        </Pressable>
        <Pressable
          onPress={onCookNow}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.actionPrimary,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.actionTextPrimary}>Cook</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    padding: KSpacing.sm,
    borderWidth: 1,
    borderColor: KColors.neutral[200],
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: KColors.sage[100],
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: { width: "100%", height: "100%", backgroundColor: KColors.sage[100] },
  body: { flex: 1, gap: 2 },
  title: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  meta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  tagRow: { flexDirection: "row", marginTop: 4 },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: KColors.sage[50],
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  actions: { gap: 6 },
  actionBtn: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
    borderRadius: KRadius.md,
    alignItems: "center",
    minWidth: 64,
  },
  actionSecondary: {
    backgroundColor: KColors.neutral[100],
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  actionPrimary: {
    backgroundColor: KColors.sage[700],
  },
  actionTextSecondary: {
    fontSize: KType.size.xs,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  actionTextPrimary: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
