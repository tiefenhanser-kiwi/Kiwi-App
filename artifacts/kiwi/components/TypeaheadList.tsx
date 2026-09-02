// Reusable floating typeahead dropdown.
//
// First consumer: grocery-list/[id].tsx "Add an item" search bar
// (WS6 6c-6-C). Designed to be consumer-agnostic via the render-prop
// pattern — Meal Builder Mode B will be the second consumer when it
// lands. Keep this primitive free of grocery-item-specific knowledge.
//
// Layout: renders as an absolute-positioned panel. Caller is responsible
// for positioning the wrapper at the desired anchor (typically directly
// below an input row); this component just renders the dropdown
// surface. Standard pattern in this codebase — see how PlanDateRangeEditor
// renders absolute below a trigger.

import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";

export interface TypeaheadListProps<T> {
  items: T[];
  visible: boolean;
  loading?: boolean;
  /** Shown when items.length === 0 && !loading. */
  emptyMessage?: string;
  renderItem: (item: T) => React.ReactNode;
  keyExtractor: (item: T) => string;
  onSelect: (item: T) => void;
  /** Dropdown panel cap; vertical scroll kicks in past this. Default 280. */
  maxHeight?: number;
  /** Outer container override (positioning, additional shadow, etc.). */
  style?: StyleProp<ViewStyle>;
  /** Per-row accessibility label hook — caller can derive from item. */
  getAccessibilityLabel?: (item: T) => string | undefined;
}

const DEFAULT_MAX_HEIGHT = 280;

export function TypeaheadList<T>({
  items,
  visible,
  loading = false,
  emptyMessage = "No suggestions — press Enter to add",
  renderItem,
  keyExtractor,
  onSelect,
  maxHeight = DEFAULT_MAX_HEIGHT,
  style,
  getAccessibilityLabel,
}: TypeaheadListProps<T>) {
  if (!visible) return null;

  const showEmpty = !loading && items.length === 0;

  return (
    <View style={[s.panel, { maxHeight }, style]}>
      {loading ? (
        <View style={s.statusRow}>
          <ActivityIndicator size="small" color={Colors.sage[700]} />
          <Text style={s.statusText}>Searching…</Text>
        </View>
      ) : showEmpty ? (
        <View style={s.statusRow}>
          <Text style={s.emptyText}>{emptyMessage}</Text>
        </View>
      ) : (
        <ScrollView
          // keyboardShouldPersistTaps="handled" lets the parent screen's
          // keyboard stay up while the user taps a suggestion — matches
          // the grocery-list screen's outer ScrollView configuration so
          // the floating panel doesn't fight the parent for taps.
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {items.map((item) => {
            const key = keyExtractor(item);
            const label = getAccessibilityLabel?.(item);
            return (
              <Pressable
                key={key}
                onPress={() => onSelect(item)}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={({ pressed }) => [
                  s.row,
                  pressed && { backgroundColor: Colors.sage[50] },
                ]}
              >
                {renderItem(item)}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    overflow: "hidden",
    ...Shadow.card,
  },
  row: {
    minHeight: 48,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.border.muted,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
  },
  statusText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  emptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
  },
});
