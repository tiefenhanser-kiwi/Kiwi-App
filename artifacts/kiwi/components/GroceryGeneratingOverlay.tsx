// WS7-7-A B6 — full-screen loading overlay shown while a plan→grocery generate
// is in flight (the AI pipeline is 5-15s). Used by the Home 1-plan direct case
// (Home stays mounted, so it needs a Modal overlay) and could back any other
// caller of useGroceryGeneration. Wraps the shared LoadingShim "status-box" so
// the label stays readable on the dimmed backdrop.

import React from "react";
import { Modal, StyleSheet, View } from "react-native";

import { Palette } from "@/constants/tokens";

import { LoadingShim } from "./LoadingShim";

export function GroceryGeneratingOverlay({ visible }: { visible: boolean }) {
  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
    >
      <View style={s.backdrop}>
        <LoadingShim variant="status-box" label="Getting your groceries…" />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: Palette.background.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
});
