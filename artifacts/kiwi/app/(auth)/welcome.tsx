import React from "react";
import { Alert, Image, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// TODO(WS9): wire ToS + Privacy Policy links to real legal pages
// when those screens exist. For WS5, both fire a "coming soon" alert.
function showLegalStub() {
  Alert.alert(
    "Coming in WS9 — ToS and Privacy Policy pages",
    "We're still drafting these. They'll be live before launch.",
  );
}

type FeatherName = React.ComponentProps<typeof Feather>["name"];

// PRD §3.2 [LOCKED] — feature copy. The retailer line ("Instacart, Whole
// Foods, or your store of choice") is a Hans-ruled placeholder held VERBATIM
// until the retailer-integration path settles; do not edit or redline it.
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
        { paddingTop: insets.top, paddingBottom: insets.bottom + Spacing[4] },
      ]}
    >
      <View style={styles.heroWrap}>
        <View style={styles.iconCircle}>
          <Image
            source={require("../../assets/images/icon.png")}
            style={styles.icon}
          />
        </View>
        {/* Interim text wordmark — the Deep Kiwi vector mark is a go-live item
            (same treatment as 3a). */}
        <Text style={styles.brand}>Kiwi</Text>
        <Text style={styles.tag}>
          Thought to Table — Streamlined Cooking for Home Chefs
        </Text>
      </View>

      <View style={styles.features}>
        {FEATURES.map((f) => (
          <View key={f.title} style={styles.featureCard}>
            <View style={styles.featureIconWrap}>
              <Feather name={f.icon} size={20} color={Colors.sage[600]} />
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
          label="Get started — it's free"
          variant="primary"
          onPress={() => router.push("/(auth)/sign-up")}
        />
        <Button
          label="I already have an account"
          variant="secondary"
          onPress={() => router.push("/(auth)/sign-in")}
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
    backgroundColor: Colors.neutral[100],
    paddingHorizontal: Spacing[5],
    justifyContent: "space-between",
  },
  heroWrap: { alignItems: "center", marginTop: Spacing[6] },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: Radius["3xl"],
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: Spacing[4],
  },
  icon: { width: 96, height: 96 },
  brand: {
    fontSize: 44,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serifItalic[700],
    letterSpacing: -1,
  },
  tag: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    marginTop: Spacing[2],
    paddingHorizontal: Spacing[3],
    lineHeight: 22,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  features: { gap: Spacing[3], marginVertical: Spacing[4] },
  featureCard: {
    flexDirection: "row",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    alignItems: "flex-start",
  },
  featureIconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius["2xl"],
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  featureTitle: {
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.semibold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  featureBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    marginTop: 2,
    lineHeight: 18,
    fontFamily: Typography.face.sans[400],
  },
  actions: { gap: Spacing[3] },
  legalLine: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    textAlign: "center",
    marginTop: Spacing[1],
    lineHeight: 16,
    fontFamily: Typography.face.sans[400],
  },
  legalLink: {
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textDecorationLine: "underline",
  },
});
