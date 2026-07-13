import React from "react";
import { Pressable, StyleSheet, View, ViewStyle } from "react-native";

import { Palette, Radius, Shadow, Spacing } from "@/constants/tokens";

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
        padded && { padding: Spacing[4] },
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
    backgroundColor: Palette.background.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.strong,
    ...Shadow.card,
  },
});
