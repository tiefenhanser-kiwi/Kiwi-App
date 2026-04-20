import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { KColors, KSpacing, KType } from "@/constants/tokens";

export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.bg,
        { paddingTop: insets.top, paddingBottom: insets.bottom + KSpacing.xl },
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
          Plan a week of meals you'll actually want to cook.
        </Text>
      </View>

      <View style={styles.bullets}>
        {BULLETS.map((b) => (
          <View key={b.title} style={styles.bullet}>
            <View style={styles.bulletDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bulletTitle}>{b.title}</Text>
              <Text style={styles.bulletBody}>{b.body}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Button
          label="Get started"
          variant="terra"
          onPress={() => router.push("/(auth)/sign-up")}
        />
        <Button
          label="I already have an account"
          variant="ghost"
          onPress={() => router.push("/(auth)/sign-in")}
          style={{ backgroundColor: "transparent", borderColor: "rgba(255,255,255,0.4)" } as any}
        />
      </View>
    </View>
  );
}

const BULLETS = [
  {
    title: "Plans built around your week",
    body: "Tell Kiwi what you need — busy nights, picky eaters, leftovers — and get a real plan in seconds.",
  },
  {
    title: "Smart grocery lists",
    body: "Auto-built from your plan and pantry. Send straight to Instacart or Whole Foods.",
  },
  {
    title: "Cook with confidence",
    body: "Step-by-step Cook Mode with timers, tips, and prep-ahead guidance.",
  },
];

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.xl,
    justifyContent: "space-between",
  },
  heroWrap: { alignItems: "center", marginTop: 32 },
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
    fontSize: KType.size.lg,
    color: "rgba(232,239,226,0.85)",
    textAlign: "center",
    marginTop: KSpacing.sm,
    paddingHorizontal: KSpacing.lg,
    lineHeight: 24,
    fontFamily: "Inter_400Regular",
  },
  bullets: { gap: KSpacing.lg, marginVertical: KSpacing.xxl },
  bullet: { flexDirection: "row", gap: KSpacing.md, alignItems: "flex-start" },
  bulletDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: KColors.terracotta[400],
    marginTop: 8,
  },
  bulletTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[100],
    fontFamily: "Inter_600SemiBold",
  },
  bulletBody: {
    fontSize: KType.size.base,
    color: "rgba(232,239,226,0.75)",
    marginTop: 2,
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
  },
  actions: { gap: KSpacing.md },
});
