import React, { useState } from "react";
import {
  Alert,
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
  /** WS7-4-B c10 — Use Plan flow. Required when plan.source === "template".
   *  Parent (PlanDiscoveryCard, c12) wires these from useTemplatePreview +
   *  useApp().useTemplateAsPlan. Optional so legacy callers with only
   *  instance rows aren't forced to thread the props. */
  onPreviewTemplate?: (templateId: string) => void;
  onUseTemplate?: (templateId: string) => Promise<{ instanceId: string }>;
};

export function PlanCardSmall({ plan, onPreviewTemplate, onUseTemplate }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const isInstance = plan.source === "instance";

  // Saved plans (source: 'instance') → Plan Review, matching PlanRow + the
  // Hero card. /plan/[id] is stub-driven until Block C4 (D-WS3-005).
  const handleOpen = () => {
    router.push({ pathname: "/plan/[id]", params: { id: plan.id } });
  };

  // WS7-4-B c10 — real Use Plan handlers (no Alert stubs).
  const handlePreview = () => {
    if (onPreviewTemplate) {
      onPreviewTemplate(plan.id);
    } else {
      Alert.alert("Preview unavailable", "This card was not wired with a preview handler.");
    }
  };
  const handleUsePlan = async () => {
    if (!onUseTemplate) {
      Alert.alert("Use Plan unavailable", "This card was not wired with a use-template handler.");
      return;
    }
    try {
      const { instanceId } = await onUseTemplate(plan.id);
      router.push({ pathname: "/plan/[id]", params: { id: instanceId } });
    } catch (err) {
      Alert.alert("Use Plan failed", err instanceof Error ? err.message : String(err));
    }
  };

  const visibleTags = plan.tags.slice(0, 3);

  return (
    <Pressable
      onPress={() => setExpanded((x) => !x)}
      style={styles.card}
    >
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
      </View>

      {expanded && (
        <View style={styles.expandedBlock}>
          {plan.description && (
            <Text style={styles.mealList} numberOfLines={3}>
              {plan.description}
            </Text>
          )}
          <View style={styles.actionRow}>
            {isInstance ? (
              <Pressable
                onPress={handleOpen}
                style={({ pressed }) => [
                  styles.actionBtn,
                  styles.actionBtnPrimary,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.actionTextPrimary}>Open</Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  onPress={handlePreview}
                  style={({ pressed }) => [
                    styles.actionBtn,
                    styles.actionBtnSecondary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.actionTextSecondary}>Preview</Text>
                </Pressable>
                <Pressable
                  onPress={handleUsePlan}
                  style={({ pressed }) => [
                    styles.actionBtn,
                    styles.actionBtnPrimary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.actionTextPrimary}>Use Plan</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    padding: KSpacing.sm,
    borderWidth: 1,
    borderColor: KColors.neutral[200],
  },
  row: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "center",
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: KColors.sage[100],
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: { width: "100%", height: "100%", backgroundColor: KColors.sage[100] },
  body: { flex: 1 },
  title: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
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
  expandedBlock: {
    marginTop: KSpacing.sm,
    paddingTop: KSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: KColors.neutral[200],
  },
  mealList: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginBottom: KSpacing.sm,
    lineHeight: 16,
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  actionBtnSecondary: {
    backgroundColor: KColors.neutral[100],
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  actionBtnPrimary: {
    backgroundColor: KColors.sage[700],
  },
  actionTextSecondary: {
    fontSize: KType.size.xs,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  actionTextPrimary: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
