import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

type Props = {
  onPress: () => void;
  locked?: boolean;
};

export function CookNowCtaCard({ onPress, locked }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        locked && styles.cardLocked,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.iconWrap}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
          <Circle
            cx="12"
            cy="12"
            r="10"
            stroke={Colors.sage[200]}
            strokeWidth={1.4}
          />
          <Path
            d="M8 12h8M12 8v8"
            stroke={Colors.terracotta[400]}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </Svg>
      </View>
      <View style={styles.text}>
        <Text style={styles.label}>What should I cook right now?</Text>
        <Text style={styles.sub}>
          Tell Kiwi what you have — get a recipe instantly
        </Text>
      </View>
      <Text style={styles.arrow}>→</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[3],
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    gap: Spacing[3],
  },
  cardLocked: {
    opacity: 0.6,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.sage[50],
    justifyContent: "center",
    alignItems: "center",
  },
  text: {
    flex: 1,
  },
  label: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  sub: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  arrow: {
    fontSize: Typography.fontSize.lg,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
  },
});
