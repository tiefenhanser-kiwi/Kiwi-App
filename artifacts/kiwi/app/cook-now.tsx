import React from "react";
import { Text, View } from "react-native";

import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { KColors, KSpacing, KType } from "@/constants/tokens";

export default function CookNowScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Cook What I Have Now" />
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
            Coming soon
          </Text>
          <Text
            style={{
              fontSize: KType.size.sm,
              color: KColors.neutral[600],
              marginTop: KSpacing.md,
              fontFamily: "Inter_400Regular",
              textAlign: "center",
              paddingHorizontal: KSpacing.xl,
            }}
          >
            The Cook What I Have Now flow lands in WS6 (AI orchestration).
            Tell Kiwi what's in your kitchen and get a meal in seconds.
          </Text>
        </View>
      </Screen>
    </View>
  );
}
