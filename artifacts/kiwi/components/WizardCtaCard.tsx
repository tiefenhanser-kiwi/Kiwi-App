import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

export type WizardIcon = "preferences" | "freeform";

type Props = {
  icon: WizardIcon;
  subLabel: string;
  onPress: () => void;
  locked?: boolean; // dims styling when premium-locked post-trial
};

function IconGlyph({ kind }: { kind: WizardIcon }) {
  // Sage outline + terracotta accent — matches prototype kiwi_prototype_v3_final.html
  if (kind === "preferences") {
    return (
      <Svg width={18} height={18} viewBox="0 0 16 16" fill="none">
        <Circle cx="8" cy="8" r="6" stroke={KColors.sage[200]} strokeWidth={1.2} />
        <Path
          d="M5 8l2 2 4-4"
          stroke={KColors.terracotta[400]}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  // freeform — list lines + accent dot
  return (
    <Svg width={18} height={18} viewBox="0 0 16 16" fill="none">
      <Path
        d="M2 4h12M2 8h8M2 12h5"
        stroke={KColors.sage[200]}
        strokeWidth={1.3}
        strokeLinecap="round"
      />
      <Circle cx="13" cy="11" r="2.2" fill={KColors.terracotta[400]} />
    </Svg>
  );
}

export function WizardCtaCard({ icon, subLabel, onPress, locked }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        locked && styles.cardLocked,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <IconGlyph kind={icon} />
        </View>
        <Text style={styles.label}>Kitchen Wizard</Text>
        <Text style={styles.sub}>{subLabel}</Text>
      </View>
      <Text style={styles.arrow}>→</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    minHeight: 124,
    justifyContent: "space-between",
  },
  cardLocked: {
    opacity: 0.6,
  },
  body: {
    flex: 1,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: KColors.sage[50],
    justifyContent: "center",
    alignItems: "center",
    marginBottom: KSpacing.sm,
  },
  label: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  sub: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 14,
  },
  arrow: {
    fontSize: KType.size.lg,
    color: KColors.sage[700],
    alignSelf: "flex-end",
    fontWeight: KType.weight.semibold,
  },
});
