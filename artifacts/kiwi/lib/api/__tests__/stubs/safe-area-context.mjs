// WS7-4-B c6 — physical react-native-safe-area-context stub for node:test.

import React from "react";

export function useSafeAreaInsets() {
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

export const SafeAreaProvider = (props) =>
  React.createElement("safe-area-provider", null, props.children);

export const SafeAreaView = (props) =>
  React.createElement("safe-area-view", props, props.children);
