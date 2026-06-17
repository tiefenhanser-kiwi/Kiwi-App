import React from "react";
import { ScrollView, StyleSheet, View, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Spacing } from "@/constants/tokens";

interface Props {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  contentStyle?: ViewStyle;
  bottomInset?: number;
}

export function Screen({
  children,
  scroll = true,
  padded = true,
  contentStyle,
  bottomInset = 24,
}: Props) {
  const insets = useSafeAreaInsets();
  const padStyle: ViewStyle = padded
    ? { paddingHorizontal: Spacing[4], paddingTop: Spacing[4] }
    : {};

  if (scroll) {
    return (
      <ScrollView
        style={styles.bg}
        contentContainerStyle={[
          padStyle,
          { paddingBottom: insets.bottom + bottomInset },
          contentStyle,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <View
      style={[
        styles.bg,
        padStyle,
        { paddingBottom: insets.bottom + bottomInset, flex: 1 },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
});
