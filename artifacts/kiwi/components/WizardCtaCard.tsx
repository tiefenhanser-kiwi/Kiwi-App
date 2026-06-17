import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

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
        <Circle cx="8" cy="8" r="6" stroke={Colors.sage[200]} strokeWidth={1.2} />
        <Path
          d="M5 8l2 2 4-4"
          stroke={Colors.terracotta[400]}
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
        stroke={Colors.sage[200]}
        strokeWidth={1.3}
        strokeLinecap="round"
      />
      <Circle cx="13" cy="11" r="2.2" fill={Colors.terracotta[400]} />
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
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[3],
    borderWidth: 1,
    borderColor: Colors.neutral[300],
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
    backgroundColor: Colors.sage[50],
    justifyContent: "center",
    alignItems: "center",
    marginBottom: Spacing[2],
  },
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 2,
  },
  sub: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 14,
  },
  arrow: {
    fontSize: Typography.fontSize.lg,
    color: Colors.sage[700],
    alignSelf: "flex-end",
    fontWeight: Typography.fontWeight.semibold,
  },
});
