import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TrialBadge } from "@/components/TrialBadge";
import { KColors, KSpacing, KType } from "@/constants/tokens";

export function HomeHeader() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + KSpacing.md }]}>
      <View style={styles.left}>
        <Text style={styles.wordmark}>Kiwi</Text>
        <Text style={styles.tagline}>
          Thought to Table — Streamlined Cooking for Home Chefs
        </Text>
      </View>
      <View style={styles.right}>
        <TrialBadge />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: KSpacing.lg,
    paddingBottom: KSpacing.md,
    backgroundColor: KColors.neutral[300],
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: KSpacing.md,
  },
  left: { flex: 1 },
  right: { paddingTop: 4 },
  wordmark: {
    fontSize: KType.size.xxl,
    color: KColors.sage[700],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
