import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

const FEATURES = [
  { icon: "infinity", title: "Unlimited plans", body: "Save and rotate as many weekly plans as you want." },
  { icon: "send", title: "One-tap grocery delivery", body: "Send your list straight to Instacart or Whole Foods." },
  { icon: "zap", title: "Full Cook Intelligence", body: "Smart timers, prep-ahead steps, and substitutions." },
  { icon: "x-circle", title: "No ads", body: "Just you and the food." },
];

export default function Upgrade() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isPremium, setPremium } = useApp();

  const handleStart = async () => {
    // RevenueCat / Stripe wiring goes here once keys arrive.
    // See attached_assets/stripe_*.ts for the locked Stripe integration spec.
    await setPremium(true);
    router.back();
  };

  return (
    <View
      style={[
        s.bg,
        { paddingTop: insets.top + KSpacing.lg, paddingBottom: insets.bottom + KSpacing.xl },
      ]}
    >
      <Pressable onPress={() => router.back()} hitSlop={12} style={s.close}>
        <Feather name="x" size={24} color="#fff" />
      </Pressable>

      <View style={s.hero}>
        <View style={s.crown}>
          <Feather name="star" size={28} color={KColors.terracotta[400]} />
        </View>
        <Text style={s.title}>Kiwi Premium</Text>
        <Text style={s.tag}>
          Plan smarter, shop faster, cook with confidence.
        </Text>
      </View>

      <View style={s.features}>
        {FEATURES.map((f) => (
          <View key={f.title} style={s.feature}>
            <View style={s.featureIcon}>
              <Feather name={f.icon as any} size={18} color={KColors.terracotta[400]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.featureTitle}>{f.title}</Text>
              <Text style={s.featureBody}>{f.body}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={s.priceCard}>
        <Text style={s.priceLabel}>30-day free trial</Text>
        <Text style={s.price}>$5.99 / month</Text>
        <Text style={s.priceSub}>Cancel anytime. Less than a coffee.</Text>
      </View>

      {isPremium ? (
        <Button
          label="You're already Premium ✓"
          variant="ghost"
          disabled
          style={{ backgroundColor: "transparent", borderColor: "rgba(255,255,255,0.4)" } as any}
        />
      ) : (
        <Button
          label="Start free trial"
          variant="terra"
          onPress={handleStart}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: KColors.sage[800],
    paddingHorizontal: KSpacing.xl,
    justifyContent: "space-between",
  },
  close: {
    width: 40,
    height: 40,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  hero: { alignItems: "center", marginTop: KSpacing.lg },
  crown: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(224,124,58,0.15)",
    borderWidth: 1,
    borderColor: "rgba(224,124,58,0.4)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: KSpacing.md,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#fff",
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  tag: {
    color: "rgba(232,239,226,0.8)",
    fontSize: KType.size.md,
    textAlign: "center",
    marginTop: 6,
    paddingHorizontal: KSpacing.lg,
    fontFamily: "Inter_400Regular",
  },
  features: { gap: KSpacing.md, marginVertical: KSpacing.xl },
  feature: { flexDirection: "row", gap: KSpacing.md, alignItems: "flex-start" },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  featureTitle: {
    color: "#fff",
    fontSize: KType.size.md,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  featureBody: {
    color: "rgba(232,239,226,0.7)",
    fontSize: KType.size.sm,
    marginTop: 2,
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
  },
  priceCard: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: KRadius.xl,
    padding: KSpacing.lg,
    alignItems: "center",
    marginBottom: KSpacing.md,
  },
  priceLabel: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[300],
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  price: {
    fontSize: 28,
    color: "#fff",
    fontWeight: "700",
    marginTop: 4,
    fontFamily: "Inter_700Bold",
  },
  priceSub: {
    fontSize: KType.size.sm,
    color: "rgba(232,239,226,0.65)",
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
});
