import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

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
            stroke={KColors.sage[200]}
            strokeWidth={1.4}
          />
          <Path
            d="M8 12h8M12 8v8"
            stroke={KColors.terracotta[400]}
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
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    gap: KSpacing.md,
  },
  cardLocked: {
    opacity: 0.6,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: KColors.sage[50],
    justifyContent: "center",
    alignItems: "center",
  },
  text: {
    flex: 1,
  },
  label: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sub: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  arrow: {
    fontSize: KType.size.lg,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
  },
});
