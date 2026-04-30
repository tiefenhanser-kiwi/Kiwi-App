import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KSpacing, KType } from "@/constants/tokens";

function planLabel(
  subscription: { status?: string; trialEndsAt?: string | null } | null | undefined,
): { label: string; isPremium: boolean } {
  const status = subscription?.status;
  if (status === "active") return { label: "Premium plan", isPremium: true };
  if (status === "trialing") {
    const trialEndsAt = subscription?.trialEndsAt ?? null;
    if (!trialEndsAt) return { label: "Premium trial", isPremium: true };
    const msLeft = new Date(trialEndsAt).getTime() - Date.now();
    const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
    if (daysLeft <= 0) return { label: "Free plan", isPremium: false };
    return {
      label: `Premium trial · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      isPremium: true,
    };
  }
  return { label: "Free plan", isPremium: false };
}

export default function ProfileTab() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { prefs, plans } = useApp();
  const { label: planText, isPremium } = planLabel(user?.subscription ?? null);
  const isActiveSub = user?.subscription?.status === "active";

  const handleLogout = async () => {
    await logout();
    router.replace("/(auth)/welcome");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Profile" />
      <Screen>
        <Card padded>
          <View style={styles.userRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {user?.firstName?.charAt(0).toUpperCase() ?? "?"}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {user ? `${user.firstName} ${user.lastName}` : "—"}
              </Text>
              <View style={styles.plan}>
                <Feather
                  name={isPremium ? "star" : "circle"}
                  size={12}
                  color={isPremium ? KColors.terracotta[400] : KColors.neutral[600]}
                />
                <Text style={styles.planText}>{planText}</Text>
              </View>
            </View>
          </View>
        </Card>

        <View style={styles.statsRow}>
          <Stat label="Plans" value={plans.length} />
          <Stat label="Household" value={prefs.household} />
        </View>

        <Section title="Cooking">
          <Row
            icon="sliders"
            label="Preferences"
            onPress={() => router.push("/onboarding-prefs")}
          />
          <Row
            icon="star"
            label={isActiveSub ? "Manage Premium" : "Upgrade to Premium"}
            onPress={() => router.push("/upgrade")}
          />
        </Section>

        <Section title="Account">
          <Row icon="mail" label={user?.email ?? "—"} />
          <Row
            icon="log-out"
            label="Sign out"
            destructive
            onPress={handleLogout}
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
