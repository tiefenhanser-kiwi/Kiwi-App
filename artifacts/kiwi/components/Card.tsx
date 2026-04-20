import React from "react";
import { Pressable, StyleSheet, View, ViewStyle } from "react-native";

import { KColors, KRadius, KShadow, KSpacing } from "@/constants/tokens";

interface Props {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  padded?: boolean;
}

export function Card({ children, onPress, style, padded = true }: Props) {
  const content = (
    <View
      style={[
        styles.card,
        padded && { padding: KSpacing.lg },
        style,
      ]}
    >
      {children}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
      >
        {content}
      </Pressable>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.xl,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    ...KShadow.card,
  },
});
