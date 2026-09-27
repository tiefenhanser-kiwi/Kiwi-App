// Row 13 "Test Kitchen" · Block 2 Part D (R5) — ONE door sheet, every door.
//
// Not one sheet per action: the ruling is a single sheet with fixed copy, and the
// action only decides which funnel row was written (useGuestDoor fires that). A
// per-action variant would invite per-action copy, and per-action copy is where
// "start your free trial" gets written by someone who did not know payments do
// not exist yet.
//
// ACCOUNT FIRST, THEN THE APP (R5): the primary button creates the account,
// because the claim is what keeps the plan and a trip to the App Store loses the
// guest session. The app is a note underneath, not a button.

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { trackGuestEvent } from "@/lib/api/guest";
import {
  DOOR_APP_NOTE,
  DOOR_INTRO,
  DOOR_PRIMARY,
  DOOR_SECONDARY,
  DOOR_SIGN_IN,
  DOOR_TITLE,
  DOOR_UNLOCKS,
  type GuestAction,
} from "@/lib/guest/doors";

export interface GuestDoorSheetProps {
  /** The action that hit the door, or null when closed. */
  action: GuestAction | null;
  onClose: () => void;
}

export function GuestDoorSheet({ action, onClose }: GuestDoorSheetProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const visible = action !== null;

  const goSignUp = () => {
    void trackGuestEvent("signup_started", { step: action ?? undefined });
    onClose();
    // The claim rides on the sign-up itself (Part E) — the screen reads the live
    // guest session, so there is no id to carry in a param.
    router.push("/(auth)/sign-up");
  };
  const goSignIn = () => {
    void trackGuestEvent("signup_started", { step: "sign_in" });
    onClose();
    router.push("/(auth)/sign-in");
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      {/* Tap-outside closes: this door is "Keep looking"-able by ruling, unlike
          the personalize nudge (R8), which must be tapped through. */}
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>{DOOR_TITLE}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
            <Feather name="x" size={22} color={Colors.neutral[700]} />
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={s.body}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.intro}>{DOOR_INTRO}</Text>
          <View style={s.list}>
            {DOOR_UNLOCKS.map((line) => (
              <View key={line} style={s.row}>
                <Feather name="check" size={16} color={Colors.sage[700]} />
                <Text style={s.rowText}>{line}</Text>
              </View>
            ))}
          </View>
          {/* ONE primary button (R5). */}
          <Button
            label={DOOR_PRIMARY}
            variant="primary"
            onPress={goSignUp}
            testID="guest-door-signup"
          />
          <Text style={s.appNote}>{DOOR_APP_NOTE}</Text>
          <Button label={DOOR_SECONDARY} variant="ghost" onPress={onClose} />
          <Pressable
            onPress={goSignIn}
            hitSlop={6}
            style={({ pressed }) => [s.signIn, pressed && { opacity: 0.6 }]}
          >
            <Text style={s.signInText}>{DOOR_SIGN_IN}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "88%",
    backgroundColor: Palette.background.card,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[300],
    marginBottom: Spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
  },
  title: {
    flex: 1,
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  body: {
    paddingTop: Spacing[3],
    paddingBottom: Spacing[4],
    gap: Spacing[3],
  },
  intro: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  list: {
    gap: Spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
  },
  rowText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  appNote: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 18,
  },
  signIn: {
    alignSelf: "center",
    paddingVertical: Spacing[2],
  },
  signInText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
});
