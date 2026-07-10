// WS7-8b Block C (BUG-026) — presentational clarify-items sheet, extracted
// from app/grocery-list/[id].tsx so the keyboard-avoiding + scrollable
// container is unit-testable (the screen itself is outside the test glob).
//
// Pure/data-injected: all clarify state (queue, index, "Other" free-text) and
// every write (resolve / leave-as-is / skip) stay in the screen; this view
// only renders and forwards taps. Mirrors the DishChooserSheetView pattern —
// KeyboardAvoidingView(behavior padding/height) + a scroll container with
// keyboardShouldPersistTaps="handled" — so the "Other…" TextInput is reachable
// and the sheet scrolls when the soft keyboard is up. Keyboard.dismiss on close
// is owned by the parent's onClose (it covers every close path, incl. the
// end-of-pass auto-close).

import React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { GroceryListItem } from "@/lib/types";

export interface ClarifySheetViewProps {
  /** Sheet visibility — drives the Modal. */
  visible: boolean;
  /** The item currently under review (undefined while none is active). */
  item: GroceryListItem | undefined;
  /** 0-based position of `item` in the queue (for the "N of M" progress). */
  index: number;
  /** Total items in the current clarify pass. */
  total: number;
  /** Whether the "Other…" free-text row is expanded. */
  otherOpen: boolean;
  onToggleOther: () => void;
  /** Controlled value of the "Other…" free-text field. */
  otherText: string;
  onChangeOtherText: (text: string) => void;
  /** Resolve the current item to `value` (a chip label or the "Other" text). */
  onResolve: (value: string) => void;
  /** Skip — leave unresolved and advance. */
  onSkip: () => void;
  /** Leave-as-is — clear the ambiguity flag without a resolution value. */
  onLeaveAsIs: () => void;
  /** Exit the flow (parent also dismisses the keyboard here). */
  onClose: () => void;
}

export function ClarifySheetView({
  visible,
  item,
  index,
  total,
  otherOpen,
  onToggleOther,
  otherText,
  onChangeOtherText,
  onResolve,
  onSkip,
  onLeaveAsIs,
  onClose,
}: ClarifySheetViewProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* BUG-026: keyboard-avoiding + scrollable so the "Other…" free-text
          input is reachable and the sheet scrolls when the soft keyboard is
          up (mirrors DishChooserSheetView's KeyboardAvoidingView + scroll
          container + keyboardShouldPersistTaps pattern). */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={s.clarifyBackdrop}
      >
        <View style={s.clarifySheet}>
          {item && (
            <ScrollView
              style={s.clarifyScroll}
              contentContainerStyle={s.clarifyScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={s.clarifyHeaderRow}>
                {/* Exit affordance — back chevron leaves the flow; progress
                    is already persisted. */}
                <Pressable onPress={onClose} hitSlop={8}>
                  <Feather
                    name="chevron-left"
                    size={24}
                    color={Colors.neutral[700]}
                  />
                </Pressable>
                <Text style={s.clarifyProgress}>
                  {index + 1} of {total}
                </Text>
                <Pressable onPress={onClose} hitSlop={8}>
                  <Text style={s.clarifyDone}>Done</Text>
                </Pressable>
              </View>

              <Text style={s.clarifyTitle}>Which one did you mean?</Text>
              <Text style={s.clarifyItemName}>{item.name}</Text>

              <View style={s.clarifyChips}>
                {(item.ambiguityOptions ?? []).map((opt) => (
                  <Pressable
                    key={opt}
                    onPress={() => onResolve(opt)}
                    style={({ pressed }) => [
                      s.clarifyChip,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text style={s.clarifyChipText}>{opt}</Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={onToggleOther}
                  style={({ pressed }) => [
                    s.clarifyChip,
                    otherOpen && s.clarifyChipActive,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={s.clarifyChipText}>Other…</Text>
                </Pressable>
              </View>

              {otherOpen && (
                <View style={s.clarifyOtherRow}>
                  <TextInput
                    value={otherText}
                    onChangeText={onChangeOtherText}
                    placeholder="Type what you want"
                    placeholderTextColor={Colors.neutral[600]}
                    style={s.clarifyOtherInput}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => onResolve(otherText)}
                  />
                  <Button
                    label="Confirm"
                    variant="primary"
                    onPress={() => onResolve(otherText)}
                    disabled={otherText.trim().length === 0}
                  />
                </View>
              )}

              <View style={s.clarifyActions}>
                <Pressable
                  onPress={onSkip}
                  hitSlop={6}
                  style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                >
                  <Text style={s.clarifySecondaryAction}>Skip</Text>
                </Pressable>
                <Pressable
                  onPress={onLeaveAsIs}
                  hitSlop={6}
                  style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                >
                  <Text style={s.clarifySecondaryAction}>Leave as is</Text>
                </Pressable>
              </View>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  // WS7-7-A B5 — clarify-any-time sheet.
  clarifyBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  clarifySheet: {
    backgroundColor: Colors.neutral[0],
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    // BUG-026: cap the sheet so the inner ScrollView (flexShrink below) has a
    // bounded height and can actually scroll its overflow when the keyboard is
    // up. Padding/gap moved to clarifyScrollContent so they apply per-child.
    maxHeight: "90%",
  },
  // BUG-026: flexShrink lets the ScrollView collapse to the capped sheet
  // height (rather than overflowing it) so its content becomes scrollable.
  clarifyScroll: {
    flexShrink: 1,
  },
  clarifyScrollContent: {
    padding: Spacing[4],
    paddingBottom: Spacing[4] + 16,
    gap: Spacing[3],
  },
  clarifyHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  clarifyProgress: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  clarifyDone: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  clarifyTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  clarifyItemName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.serif[400],
  },
  clarifyChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[2],
  },
  clarifyChip: {
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.border.default,
    backgroundColor: Palette.background.card,
  },
  clarifyChipActive: {
    borderColor: Colors.sage[700],
    backgroundColor: Colors.sage[100],
  },
  clarifyChipText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  clarifyOtherRow: {
    gap: Spacing[2],
  },
  clarifyOtherInput: {
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  clarifyActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing[1],
  },
  clarifySecondaryAction: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
});
