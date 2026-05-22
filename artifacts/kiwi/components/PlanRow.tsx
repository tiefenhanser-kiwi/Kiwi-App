import React from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import type { PlanListItem } from "@/lib/api/plans";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

type Props = {
  plan: PlanListItem;
};

export function PlanRow({ plan }: Props) {
  const router = useRouter();

  // Open → Plan Review, matching the Hero card + This Week callout. The
  // /plan/[id] screen is still stub-driven until Block C4 (D-WS3-005);
  // C2 just wires the navigation.
  const handleOpen = () => {
    router.push({ pathname: "/plan/[id]", params: { id: plan.id } });
  };

  const visibleTags = plan.tags.slice(0, 3);

  return (
    <View style={styles.row}>
      <View style={styles.thumb}>
        {plan.image ? (
          <Image
            source={{ uri: plan.image }}
            style={styles.thumbImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.thumbFallback} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {plan.name}
        </Text>
        {plan.description && (
          <Text style={styles.meta} numberOfLines={1}>
            {plan.description}
          </Text>
        )}
        {visibleTags.length > 0 && (
          <View style={styles.tagRow}>
            {visibleTags.map((t) => (
              <View key={t} style={styles.tag}>
                <Text style={styles.tagText}>{t}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <Pressable
        onPress={handleOpen}
        style={({ pressed }) => [styles.openBtn, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.openText}>Open</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    padding: KSpacing.sm,
    borderWidth: 1,
    borderColor: KColors.neutral[200],
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: KColors.sage[100],
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: { width: "100%", height: "100%", backgroundColor: KColors.sage[100] },
  body: { flex: 1, gap: 2 },
  title: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  meta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  tagRow: {
    flexDirection: "row",
    gap: 4,
    marginTop: 4,
    flexWrap: "wrap",
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: KColors.sage[50],
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  openBtn: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    backgroundColor: KColors.sage[700],
  },
  openText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
