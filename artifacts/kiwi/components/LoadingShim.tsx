// Shared loading-state UI for mutation + future query consumers.
//
// Establishes the visual idiom: a sage ActivityIndicator paired with a
// "Kiwi is thinking…" (or caller-supplied) label. Three variants cover
// the call sites WS7-1 migrates today; further consumers (the cancellable
// useEffect idioms in plans.tsx / PlanDiscoveryCard.tsx etc.) adopt this
// in WS7-2+ alongside their endpoint integrations.
//
// Variants:
//   - "status-box": large card with centered spinner + label. Drop-in for
//     [wizard-results.tsx](../app/wizard-results.tsx)'s `mutation.isPending`
//     box.
//   - "screen":     full-bleed centered spinner + label for full-screen
//     loading states. Future migration target for import-url / import-image
//     / import-text — NOT migrated in this commit.
//   - "inline":     small horizontal row (spinner + text) for inline status
//     under a submit button or list section. Drop-in for the
//     [tellkiwi.tsx](../app/tellkiwi.tsx) `thinkingRow` and the
//     [SwapMealSheet.tsx](./SwapMealSheet.tsx) `loadingCard` shape (Similar mode).

import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export type LoadingShimVariant = "status-box" | "screen" | "inline";

export interface LoadingShimProps {
  variant: LoadingShimVariant;
  /** Defaults to "Kiwi is thinking…". Pass a flow-specific verb when relevant. */
  label?: string;
}

export function LoadingShim({
  variant,
  label = "Kiwi is thinking…",
}: LoadingShimProps) {
  if (variant === "status-box") {
    return (
      <View style={s.statusBox}>
        <ActivityIndicator size="large" color={Colors.sage[700]} />
        <Text style={s.statusText}>{label}</Text>
      </View>
    );
  }
  if (variant === "screen") {
    return (
      <View style={s.screen}>
        <ActivityIndicator size="large" color={Colors.sage[700]} />
        <Text style={s.screenText}>{label}</Text>
      </View>
    );
  }
  return (
    <View style={s.inline}>
      <ActivityIndicator size="small" color={Colors.sage[700]} />
      <Text style={s.inlineText}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  statusBox: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  statusText: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing[3],
  },
  screenText: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  inlineText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[400],
  },
});
