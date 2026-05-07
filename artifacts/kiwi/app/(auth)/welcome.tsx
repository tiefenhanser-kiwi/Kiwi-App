import React from "react";
import { Alert, Image, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

// TODO(WS9): wire ToS + Privacy Policy links to real legal pages
// when those screens exist. For WS5, both fire a "coming soon" alert.
function showLegalStub() {
  Alert.alert(
    "Coming in WS9 — ToS and Privacy Policy pages",
    "We're still drafting these. They'll be live before launch.",
  );
}

type FeatherName = React.ComponentProps<typeof Feather>["name"];

const FEATURES: Array<{
  icon: FeatherName;
  title: string;
  body: string;
}> = [
  {
    icon: "calendar",
    title: "Skip the meal-planning stress",
    body: "Kiwi suggests dinners based on what you like, what's in season, and what you already have.",
  },
  {
    icon: "shopping-cart",
    title: "Get groceries without the legwork",
    body: "Kiwi builds your list and sends it to Instacart, Whole Foods, or your store of choice.",
  },
  {
    icon: "check-circle",
    title: "Cook with confidence, step by step",
    body: "Prep smarter, cook efficiently, and follow along without thinking — Kiwi handles the sequencing.",
  },
];

export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.bg,
        { paddingTop: insets.top, paddingBottom: insets.bottom + KSpacing.lg },
      ]}
    >
      <View style={styles.heroWrap}>
        <View style={styles.iconCircle}>
          <Image
            source={require("../../assets/images/icon.png")}
            style={styles.icon}
          />
        </View>
        <Text style={styles.brand}>Kiwi</Text>
        <Text style={styles.tag}>
          Thought to Table — Streamlined Cooking for Home Chefs
        </Text>
      </View>

      <View style={styles.features}>
        {FEATURES.map((f) => (
          <View key={f.title} style={styles.featureCard}>
            <View style={styles.featureIconWrap}>
              <Feather name={f.icon} size={20} color={KColors.terracotta[300]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.featureTitle}>{f.title}</Text>
              <Text style={styles.featureBody}>{f.body}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Button
          label="Start Free 30-Day Trial"
          variant="terra"
          onPress={() => router.push("/(auth)/sign-up")}
        />
        <Button
          label="Log In"
          variant="primary"
          onPress={() => router.push("/(auth)/sign-in")}
          style={{ borderColor: "rgba(255,255,255,0.4)", borderWidth: 1 } as any}
        />
        <Text style={styles.legalLine}>
          By continuing you agree to our{" "}
          <Text style={styles.legalLink} onPress={showLegalStub}>
            Terms of Service
          </Text>
          {" "}and{" "}
          <Text style={styles.legalLink} onPress={showLegalStub}>
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.xl,
    justifyContent: "space-between",
  },
  heroWrap: { alignItems: "center", marginTop: 24 },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 28,
    backgroundColor: KColors.sage[800],
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: KSpacing.lg,
  },
  icon: { width: 96, height: 96 },
  brand: {
    fontSize: 44,
    fontWeight: "700",
    color: KColors.neutral[100],
    fontFamily: "Inter_700Bold",
    letterSpacing: -1,
  },
  tag: {
    fontSize: KType.size.md,
    color: "rgba(232,239,226,0.85)",
    textAlign: "center",
    marginTop: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    lineHeight: 22,
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  features: { gap: KSpacing.md, marginVertical: KSpacing.lg },
  featureCard: {
    flexDirection: "row",
    gap: KSpacing.md,
    backgroundColor: KColors.sage[800],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    alignItems: "flex-start",
  },
  featureIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  featureTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[100],
    fontFamily: "Inter_600SemiBold",
  },
  featureBody: {
    fontSize: KType.size.sm,
    color: "rgba(232,239,226,0.78)",
    marginTop: 2,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  actions: { gap: KSpacing.md },
  legalLine: {
    fontSize: KType.size.xs,
    color: "rgba(232,239,226,0.7)",
    textAlign: "center",
    marginTop: KSpacing.xs,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
  },
  legalLink: {
    color: KColors.neutral[100],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textDecorationLine: "underline",
  },
});
