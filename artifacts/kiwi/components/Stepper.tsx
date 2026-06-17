import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";

interface Props {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  suffix,
}: Props) {
  const disabledMin = value <= min;
  const disabledMax = value >= max;

  const dec = () => {
    if (disabledMin) return;
    onChange(Math.max(min, value - step));
  };
  const inc = () => {
    if (disabledMax) return;
    onChange(Math.min(max, value + step));
  };

  return (
    <View style={s.wrap}>
      <Pressable
        onPress={dec}
        disabled={disabledMin}
        hitSlop={8}
        style={({ pressed }) => [
          s.btn,
          disabledMin && { opacity: 0.4 },
          pressed && !disabledMin && { opacity: 0.6 },
        ]}
      >
        <Feather name="minus" size={18} color={Colors.sage[700]} />
      </Pressable>
      <View style={s.center}>
        <Text style={s.value}>{value}</Text>
        {suffix && <Text style={s.suffix}>{suffix}</Text>}
      </View>
      <Pressable
        onPress={inc}
        disabled={disabledMax}
        hitSlop={8}
        style={({ pressed }) => [
          s.btn,
          disabledMax && { opacity: 0.4 },
          pressed && !disabledMax && { opacity: 0.6 },
        ]}
      >
        <Feather name="plus" size={18} color={Colors.sage[700]} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.neutral[100],
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: 6,
    alignSelf: "flex-start",
    gap: Spacing[4],
    minWidth: 180,
    justifyContent: "space-between",
  },
  btn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    alignItems: "center",
    minWidth: 80,
  },
  value: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[700],
  },
  suffix: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
});
