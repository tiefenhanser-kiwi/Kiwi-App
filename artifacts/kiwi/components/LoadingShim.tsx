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
//     [FindSimilarSheet.tsx](./FindSimilarSheet.tsx) `loadingCard` shapes.

import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

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
        <ActivityIndicator size="large" color={KColors.sage[700]} />
        <Text style={s.statusText}>{label}</Text>
      </View>
    );
  }
  if (variant === "screen") {
    return (
      <View style={s.screen}>
        <ActivityIndicator size="large" color={KColors.sage[700]} />
        <Text style={s.screenText}>{label}</Text>
      </View>
    );
  }
  return (
    <View style={s.inline}>
      <ActivityIndicator size="small" color={KColors.sage[700]} />
      <Text style={s.inlineText}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  statusBox: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
  },
  statusText: {
    fontSize: KType.size.md,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: KSpacing.md,
  },
  screenText: {
    fontSize: KType.size.md,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  inlineText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontFamily: "Inter_400Regular",
  },
});
