// WS9 Redesign Arc Block 2c Part A (D-WS9-244) — the bulk intake's review
// sheet, shown over the Playlist tab when a run finishes.
//
// Hans's copy: "Kiwi imported your favorites. Double check the recipes in
// case Kiwi missed your secret ingredient." One row per saved meal with a
// "Review ›" that opens that meal's editor; the row flips to "Reviewed ✓"
// when the editor saves (lib/builder/playlistImportReview marks it). NOTHING
// is required — Done is always live; the meals are already saved.
//
// A transparent Modal, the SwapMealSheet idiom. The host hides it while an
// editor is open above the tab (a native Modal would otherwise sit over the
// pushed screen) and shows it again when the tab regains focus.

import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { ImportReviewItem } from "@/lib/builder/playlistImportReview";

export const IMPORT_REVIEW_TITLE = "Kiwi imported your favorites.";
export const IMPORT_REVIEW_BODY =
  "Double check the recipes in case Kiwi missed your secret ingredient.";
export const IMPORT_REVIEW_ACTION = "Review ›";
export const IMPORT_REVIEWED = "Reviewed ✓";
export const IMPORT_REVIEW_DONE = "Done";

export interface PlaylistImportReviewSheetProps {
  visible: boolean;
  items: ImportReviewItem[];
  onReview: (mealId: string) => void;
  onDone: () => void;
}

export function PlaylistImportReviewSheet({
  visible,
  items,
  onReview,
  onDone,
}: PlaylistImportReviewSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDone}
      statusBarTranslucent
    >
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDone} accessibilityLabel="Dismiss" />
        <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[4] }]} testID="playlist-import-review">
          <View style={s.handle} />
          <Text style={s.title}>{IMPORT_REVIEW_TITLE}</Text>
          <Text style={s.body}>{IMPORT_REVIEW_BODY}</Text>
          <View style={s.list}>
            {items.map((item) => (
              <View key={item.mealId} style={s.row} accessibilityLabel={`Imported ${item.title}`}>
                <Feather
                  name={item.reviewed ? "check-circle" : "circle"}
                  size={18}
                  color={item.reviewed ? Colors.sage[700] : Colors.neutral[500]}
                />
                <Text style={s.rowTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                {item.reviewed ? (
                  <Text style={s.reviewed} testID={`import-reviewed-${item.mealId}`}>
                    {IMPORT_REVIEWED}
                  </Text>
                ) : (
                  <Pressable
                    onPress={() => onReview(item.mealId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Review ${item.title}`}
                    hitSlop={8}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={s.reviewAction}>{IMPORT_REVIEW_ACTION}</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
          <Button
            label={IMPORT_REVIEW_DONE}
            variant="primary"
            onPress={onDone}
            testID="playlist-import-done"
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: Palette.background.overlay,
  },
  sheet: {
    backgroundColor: Palette.background.card,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    gap: Spacing[3],
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.neutral[300],
  },
  title: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  body: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  list: { gap: Spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingVertical: Spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[200],
  },
  rowTitle: {
    flex: 1,
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  reviewAction: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  reviewed: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
});
