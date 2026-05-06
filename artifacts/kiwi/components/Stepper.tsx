import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

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
        <Feather name="minus" size={18} color={KColors.sage[700]} />
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
        <Feather name="plus" size={18} color={KColors.sage[700]} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: KColors.neutral[100],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
    alignSelf: "flex-start",
    gap: KSpacing.lg,
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
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  suffix: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
