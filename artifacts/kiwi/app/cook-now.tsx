import React from "react";
import { Text, View } from "react-native";

import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { Colors, Spacing, Typography } from "@/constants/tokens";

export default function CookNowScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header title="Cook What I Have Now" />
      <Screen>
        <View style={{ paddingTop: Spacing[6], alignItems: "center" }}>
          <Text
            style={{
              fontSize: Typography.fontSize.md,
              color: Colors.neutral[700],
              fontFamily: Typography.face.sans[400],
              textAlign: "center",
            }}
          >
            Coming soon
          </Text>
          <Text
            style={{
              fontSize: Typography.fontSize.sm,
              color: Colors.neutral[600],
              marginTop: Spacing[3],
              fontFamily: Typography.face.sans[400],
              textAlign: "center",
              paddingHorizontal: Spacing[5],
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
