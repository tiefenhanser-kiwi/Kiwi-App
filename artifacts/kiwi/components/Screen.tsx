import React from "react";
import { ScrollView, StyleSheet, View, ViewStyle, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Spacing } from "@/constants/tokens";

interface Props {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  contentStyle?: ViewStyle;
  bottomInset?: number;
  /** CLIENT-9 E — the Plans tab loads its next page near the end (scroll only). */
  onScroll?: ScrollViewProps["onScroll"];
  onContentSizeChange?: ScrollViewProps["onContentSizeChange"];
  onLayout?: ScrollViewProps["onLayout"];
}

export function Screen({
  children,
  scroll = true,
  padded = true,
  contentStyle,
  bottomInset = 24,
  onScroll,
  onContentSizeChange,
  onLayout,
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
        onScroll={onScroll}
        scrollEventThrottle={onScroll ? 100 : undefined}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
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
