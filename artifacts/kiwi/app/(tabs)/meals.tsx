import React from "react";
import { Text, View } from "react-native";

import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { KColors, KSpacing, KType } from "@/constants/tokens";

export default function MealsTab() {
  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="My Meals" />
      <Screen>
        <View style={{ paddingTop: KSpacing.xxl, alignItems: "center" }}>
          <Text
            style={{
              fontSize: KType.size.md,
              color: KColors.neutral[700],
              fontFamily: "Inter_400Regular",
              textAlign: "center",
            }}
          >
            My Meals — coming in Workstream 4 (Scope cleanup)
          </Text>
          <Text
            style={{
              fontSize: KType.size.sm,
              color: KColors.neutral[600],
              marginTop: KSpacing.md,
              fontFamily: "Inter_400Regular",
              textAlign: "center",
            }}
          >
            This tab will replace the existing Library screen with the
            PRD §9 My Meals surface.
          </Text>
        </View>
      </Screen>
    </View>
  );
}
