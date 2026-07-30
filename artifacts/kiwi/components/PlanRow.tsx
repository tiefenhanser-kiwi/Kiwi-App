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
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { PlanCardOverflowMenu } from "@/components/PlanCardOverflowMenu";

type Props = {
  plan: PlanListItem;
  /** WS7-4-B c9 — Use Plan flow. Fired when the row's plan is a Template;
   *  the parent screen routes the id into <PlanPreviewModal>. Required when
   *  the row may receive template-sourced rows (Plans tab does; legacy
   *  callers with only Instance rows can pass a no-op). */
  onPreviewTemplate?: (templateId: string) => void;
  // WS9 3d Part 1c — plan-card "⋯" host (D-WS9-001 / D-WS9-008). Supplied only
  // for saved plans (source === "instance"); the parent screen owns the
  // Compost confirm+undo and the Use-again copy. Each item hides when its
  // handler is omitted (Use-again is dropped when the plan has no template).
  onCompost?: (plan: PlanListItem) => void;
  onUseAgain?: (plan: PlanListItem) => void;
};

export function PlanRow({ plan, onPreviewTemplate, onCompost, onUseAgain }: Props) {
  const router = useRouter();

  // WS7-4-B c9 — source dispatcher. Templates route into the preview overlay
  // so the user can see the contents before committing; Instances open Plan
  // Review directly (existing behavior).
  const handleOpen = () => {
    if (plan.source === "template" && onPreviewTemplate) {
      onPreviewTemplate(plan.id);
      return;
    }
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
      {/* WS9 3d Part 1c — "⋯" only on saved plans; templates keep their own
          Use/Preview flow and have no plan-lifecycle actions. */}
      {plan.source === "instance" && (onCompost || onUseAgain) && (
        <PlanCardOverflowMenu
          accessibilityLabel={`Actions for ${plan.name}`}
          onCompost={onCompost ? () => onCompost(plan) : undefined}
          onUseAgain={onUseAgain ? () => onUseAgain(plan) : undefined}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    padding: Spacing[2],
    borderWidth: 1,
    borderColor: Colors.neutral[200],
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
    overflow: "hidden",
    backgroundColor: Colors.sage[100],
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: { width: "100%", height: "100%", backgroundColor: Colors.sage[100] },
  body: { flex: 1, gap: 2 },
  title: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  meta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
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
    backgroundColor: Colors.sage[50],
    borderRadius: 4,
  },
  tagText: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  openBtn: {
    paddingHorizontal: Spacing[3],
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.sage[700],
  },
  openText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
