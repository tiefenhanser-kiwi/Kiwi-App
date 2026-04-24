import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KSpacing, KType } from "@/constants/tokens";

// TODO(WS2-E): Restore real user display from GET /auth/me.
// Placeholder values shown during WS2 Clerk rip.

export default function ProfileTab() {
  const router = useRouter();
  const { prefs, isPremium, plans, pantry } = useApp();

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Profile" />
      <Screen>
        <Card padded>
          <View style={styles.userRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>G</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>Guest</Text>
              <View style={styles.plan}>
                <Feather
                  name={isPremium ? "star" : "circle"}
                  size={12}
                  color={isPremium ? KColors.terracotta[400] : KColors.neutral[600]}
                />
                <Text style={styles.planText}>
                  {isPremium ? "Kiwi Premium" : "Free plan"}
                </Text>
              </View>
            </View>
          </View>
        </Card>

        <View style={styles.statsRow}>
          <Stat label="Plans" value={plans.length} />
          <Stat label="Pantry" value={pantry.length} />
          <Stat label="Household" value={prefs.household} />
        </View>

        <Section title="Cooking">
          <Row
            icon="sliders"
            label="Preferences"
            onPress={() => router.push("/onboarding-prefs")}
          />
          <Row
            icon="package"
            label="My Pantry"
            onPress={() => router.push("/pantry")}
          />
          <Row
            icon="star"
            label={isPremium ? "Manage Premium" : "Upgrade to Premium"}
            onPress={() => router.push("/upgrade")}
          />
        </Section>

        <Section title="Account">
          <Row icon="mail" label="—" />
          <Row
            icon="log-out"
            label="Sign out"
            destructive
            onPress={() => router.replace("/(auth)/welcome")}
          />
        </Section>
      </Screen>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card padded style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Card>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginTop: KSpacing.xl }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Card padded={false} style={{ overflow: "hidden" }}>
        {children}
      </Card>
    </View>
  );
}

function Row({
  icon,
  label,
  onPress,
  destructive,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress?: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
      disabled={!onPress}
    >
      <Feather
        name={icon}
        size={18}
        color={destructive ? KColors.terracotta[600] : KColors.sage[700]}
      />
      <Text
        style={[
          styles.rowLabel,
          destructive && { color: KColors.terracotta[600] },
        ]}
      >
        {label}
      </Text>
      {onPress && (
        <Feather name="chevron-right" size={18} color={KColors.neutral[600]} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: "row", alignItems: "center", gap: KSpacing.md },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: KColors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: KColors.neutral[100],
    fontSize: 22,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
  },
  name: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  plan: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  planText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  statsRow: {
    flexDirection: "row",
    gap: KSpacing.md,
    marginTop: KSpacing.md,
  },
  statCard: { flex: 1, alignItems: "center" },
  statValue: {
    fontSize: KType.size.xxl,
    fontWeight: "700",
    color: KColors.sage[700],
    fontFamily: "Inter_700Bold",
  },
  statLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  sectionTitle: {
    fontSize: KType.size.sm,
    color: KColors.sage[600],
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: KSpacing.sm,
    paddingHorizontal: 4,
    fontFamily: "Inter_600SemiBold",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
  },
  rowLabel: {
    flex: 1,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
});
