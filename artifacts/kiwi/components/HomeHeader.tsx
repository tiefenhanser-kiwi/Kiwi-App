import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TrialBadge } from "@/components/TrialBadge";
import { Colors, Spacing, Typography } from "@/constants/tokens";

export function HomeHeader() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + Spacing[3] }]}>
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
    paddingHorizontal: Spacing[4],
    paddingBottom: Spacing[3],
    backgroundColor: Colors.neutral[300],
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: Spacing[3],
  },
  left: { flex: 1 },
  right: { paddingTop: 4 },
  wordmark: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[600],
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
});
