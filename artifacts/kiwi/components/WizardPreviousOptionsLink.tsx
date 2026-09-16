// Plan-Gen Arc Block 4b-3 (D-WS9-072) — "See Previous Options" link.
//
// Persistent inline banner on the generate surfaces (/wizard, /tellkiwi) that
// re-shows the user's LAST generated plan-options batch without regenerating.
// Replaces the old mount-time resume interstitial (which could only catch the
// user at one moment). Hidden when the user has no batch.
//
// Tapping mounts plan-options in "rehydrate" mode (rehydrate:"1") fed by the
// stored candidates — no AI call. Block 2c Part E: when the slot holds a SHELF
// batch (source:"shelf", the cards last shown on the Pick screen) it opens the
// Pick screen re-hydrated from those cards instead — selections not restored. The batch is GLOBAL (one per user), so this
// link shows the same last run on either form regardless of which route
// produced it; params branch on batch.source so expand/activate can rebuild
// candidateContext (wizard/tellkiwi replay `input`).

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  getWizardLastBatch,
  type GetWizardLastBatchResponse,
} from "@/lib/api/wizard";
import {
  buildRehydrateParams,
  buildShelfRehydrateParams,
  previousOptionsSubtitle,
  shouldShowPreviousOptions,
} from "@/lib/wizard/previousOptions";

export function WizardPreviousOptionsLink() {
  const router = useRouter();
  const query = useQuery<GetWizardLastBatchResponse>({
    queryKey: ["wizard", "lastBatch"],
    queryFn: getWizardLastBatch,
    // Snapshot semantics — always re-check on mount so the link reflects the
    // newest run (and disappears if a fresh generation just replaced it).
    staleTime: 0,
  });

  const batch = query.data?.batch ?? null;
  // Hidden entirely when there's no batch (most new users) or while loading /
  // on error — the link is an assist, never a blocker.
  if (!shouldShowPreviousOptions(batch) || !batch) return null;

  const handlePress = () => {
    // Block 2c Part E — a SHELF batch re-opens the Pick screen from the cards
    // it last showed; a plans batch rehydrates the plan-options screen
    // (D-WS9-191 Block 2 — the same rehydrate params the retired chooser took).
    const shelfParams = buildShelfRehydrateParams(batch);
    if (shelfParams) {
      router.push({ pathname: "/pick-meals", params: shelfParams });
      return;
    }
    router.push({
      pathname: "/plan-options",
      params: buildRehydrateParams(batch),
    });
  };

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}
    >
      <View style={s.iconWrap}>
        <Feather name="rotate-ccw" size={18} color={Colors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.title}>See previous options</Text>
        <Text style={s.subtitle}>{previousOptionsSubtitle(batch)}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={Colors.neutral[600]} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    paddingVertical: Spacing[3],
    paddingHorizontal: Spacing[4],
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.sage[100],
  },
  title: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 1,
  },
});
