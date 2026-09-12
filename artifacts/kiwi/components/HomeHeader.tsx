// WS9 Block 3a — Home header. Composition (spec §5.1 ruling, which supersedes
// the mockup's stale greeting+wordmark header): mark top-left · time-of-day
// greeting · trial badge + avatar chip top-right (badge LEFT of the chip). The
// avatar chip is the sole profile entry after G7 (OPEN-1). R-3a-1: the PRD
// §4.2.1 tagline ("Thought to Table…") does NOT carry into A1 — dropped.
//
// Mark = the Deep Kiwi mark, `assets/images/header-mark-28.png` (+ @2x / @3x,
// which RN's density resolution picks from the base name). The PNGs are
// rasters of the vector master `assets/images/kiwi-mark.svg`; regenerate from
// that, never hand-edit. The image replaces a text wordmark, so it carries
// accessibilityLabel="Kiwi" — a screen reader still hears the name.

import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
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
        {/* Mark — Deep Kiwi, 28×28. Same relative-require form as the rest of
            the app's local images (app/(auth)/welcome.tsx). */}
        <Image
          source={require("../assets/images/header-mark-28.png")}
          style={styles.mark}
          accessible
          accessibilityLabel="Kiwi"
        />
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
    width: 28,
    height: 28,
  },
  // BUG-035 — the declared numeric weight must MATCH the loaded face, or
  // Android synthesises a bold on top of it. This was the last surviving site
  // of that defect app-wide (semibold/600 declared over the Medium/500 italic
  // face); every other serif style in the app already pairs correctly.
  // Resolved toward the FACE, not the weight: 500 Medium Italic is the greeting
  // treatment the header was designed with, so the numeric weight is what was
  // wrong, not the family.
  greeting: {
    marginTop: Spacing[3],
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.serifItalic[500],
    fontStyle: "italic",
  },
});
