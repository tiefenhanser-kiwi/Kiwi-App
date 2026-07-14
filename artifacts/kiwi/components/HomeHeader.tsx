// WS9 Block 3a — Home header. Composition (spec §5.1 ruling, which supersedes
// the mockup's stale greeting+wordmark header): mark top-left · time-of-day
// greeting · trial badge + avatar chip top-right (badge LEFT of the chip). The
// avatar chip is the sole profile entry after G7 (OPEN-1). R-3a-1: the PRD
// §4.2.1 tagline ("Thought to Table…") does NOT carry into A1 — dropped.
//
// Mark = interim TEXT wordmark (the Deep Kiwi vector rebuild is unstarted —
// tracked as a go-live item). Rendered in Colors.sage[700] (never the raw
// #3a5235 literal — tokens are the value authority).

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AvatarChip } from "@/components/AvatarChip";
import { TrialBadge } from "@/components/TrialBadge";
import { useAuth } from "@/contexts/AuthContext";
import { Colors, Spacing, Typography } from "@/constants/tokens";

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function HomeHeader() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  const firstName = user?.firstName ?? "there";
  const greeting = `${timeOfDayGreeting()}, ${firstName}`;
  const fullName = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim();
  const initials = initialsFor(fullName || firstName);

  return (
    <View style={[styles.container, { paddingTop: insets.top + Spacing[3] }]}>
      <View style={styles.topRow}>
        {/* Mark — interim text wordmark (TODO(logo): Deep Kiwi vector). */}
        <Text style={styles.mark}>kiwi</Text>
        <View style={styles.right}>
          {/* Badge sits LEFT of the chip (spec §5.1). Self-hides when not trialing. */}
          <TrialBadge />
          <AvatarChip
            initials={initials}
            onPress={() => router.push("/(tabs)/profile")}
          />
        </View>
      </View>
      <Text style={styles.greeting} numberOfLines={1}>
        {greeting}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing[4],
    paddingBottom: Spacing[3],
    backgroundColor: Colors.neutral[300],
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[3],
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  mark: {
    fontSize: Typography.fontSize.xl,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serifItalic[600],
    fontStyle: "italic",
    letterSpacing: -0.3,
  },
  greeting: {
    marginTop: Spacing[3],
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serifItalic[500],
    fontStyle: "italic",
  },
});
