// Row 13 "Test Kitchen" · Block 2 Part F (R8 / D-WS9-263) — the personalize
// popup, on Home, after a claim.
//
// 🔴 THE USER MUST TAP THROUGH IT. No backdrop press, no onRequestClose escape
// to nowhere: `onRequestClose` maps to "Later" (the Android back button has to do
// SOMETHING, and silently closing would leave both flags unset and show it
// again). This is the one modal in the guest lane that is not dismissible by
// tapping outside — the door sheet is, by ruling, and this is not.
//
// The copy is in lib/home/personalizeNudge.ts, pinned word for word by its test.

import React from "react";
import { Modal, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  NUDGE_BODY,
  NUDGE_PRIMARY,
  NUDGE_SECONDARY,
  NUDGE_TITLE,
} from "@/lib/home/personalizeNudge";

export interface PersonalizeNudgeModalProps {
  visible: boolean;
  /** PATCH /me/ui-state { personalizeNudgeDismissed: true }, then Preferences. */
  onPersonalize: () => void;
  /** The per-device flag only — the server flag stays unset. */
  onLater: () => void;
  /** True while the PATCH is in flight, so the primary cannot be double-tapped. */
  busy?: boolean;
}

export function PersonalizeNudgeModal({
  visible,
  onPersonalize,
  onLater,
  busy = false,
}: PersonalizeNudgeModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      // Android's back button. It resolves to "Later" rather than to nothing:
      // a close that set neither flag would show this again on the next Home.
      onRequestClose={onLater}
    >
      {/* NO Pressable backdrop — see the header. */}
      <View style={s.backdrop}>
        <View style={s.card} testID="personalize-nudge">
          <Text style={s.title}>{NUDGE_TITLE}</Text>
          <Text style={s.body}>{NUDGE_BODY}</Text>
          <View style={s.actions}>
            <Button
              label={NUDGE_PRIMARY}
              variant="primary"
              onPress={onPersonalize}
              disabled={busy}
              testID="personalize-nudge-primary"
            />
            <Button
              label={NUDGE_SECONDARY}
              variant="ghost"
              onPress={onLater}
              disabled={busy}
              testID="personalize-nudge-later"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[4],
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[4],
    gap: Spacing[3],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  body: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  actions: {
    gap: Spacing[2],
    marginTop: Spacing[1],
  },
});
