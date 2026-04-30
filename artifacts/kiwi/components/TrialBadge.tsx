import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";

import { useAuth } from "@/contexts/AuthContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

type TrialState = "active" | "expiring" | "expired" | "hidden";

const EXPIRING_THRESHOLD_DAYS = 3;

function computeTrialState(
  status: string | undefined,
  trialEndsAt: string | null | undefined,
): { state: TrialState; daysLeft: number } {
  // No subscription data yet (still loading) — hide
  if (!status) return { state: "hidden", daysLeft: 0 };

  // Paid subscriber — no trial badge to show
  if (status === "active") return { state: "hidden", daysLeft: 0 };

  // Anything other than trialing — surface as expired
  if (status !== "trialing") return { state: "expired", daysLeft: 0 };

  // Trialing but no end date set — defensive expired
  if (!trialEndsAt) return { state: "expired", daysLeft: 0 };

  const msLeft = new Date(trialEndsAt).getTime() - Date.now();
  const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));

  if (daysLeft <= 0) return { state: "expired", daysLeft: 0 };
  if (daysLeft <= EXPIRING_THRESHOLD_DAYS) return { state: "expiring", daysLeft };
  return { state: "active", daysLeft };
}

export function TrialBadge() {
  const router = useRouter();
  const { user } = useAuth();

  const { state, daysLeft } = useMemo(
    () =>
      computeTrialState(
        user?.subscription?.status,
        user?.subscription?.trialEndsAt ?? null,
      ),
    [user?.subscription?.status, user?.subscription?.trialEndsAt],
  );

  if (state === "hidden") return null;

  const copy =
    state === "active"
      ? `30-day trial · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
      : state === "expiring"
        ? `Trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
        : "Trial expired — Upgrade →";

  const containerStyle =
    state === "active"
      ? styles.containerActive
      : state === "expiring"
        ? styles.containerExpiring
        : styles.containerExpired;

  const textStyle =
    state === "active"
      ? styles.textActive
      : state === "expiring"
        ? styles.textExpiring
        : styles.textExpired;

  return (
    <Pressable
      onPress={() => router.push("/upgrade")}
      style={({ pressed }) => [containerStyle, pressed && { opacity: 0.7 }]}
      hitSlop={6}
    >
      <Text style={textStyle}>{copy}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  containerActive: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
    borderRadius: KRadius.pill,
    backgroundColor: KColors.sage[100],
    borderWidth: 1,
    borderColor: KColors.sage[300],
  },
  containerExpiring: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
    borderRadius: KRadius.pill,
    backgroundColor: KColors.terracotta[50],
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
  },
  containerExpired: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
    borderRadius: KRadius.pill,
    backgroundColor: KColors.terracotta[400],
  },
  textActive: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  textExpiring: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[600],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  textExpired: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontFamily: "Inter_600SemiBold",
    fontWeight: KType.weight.semibold,
  },
});
