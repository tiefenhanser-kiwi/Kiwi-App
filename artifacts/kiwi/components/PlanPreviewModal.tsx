// WS7-4-B c6 — Plan preview overlay for the Use Plan flow (PRD §9.2.5).
// Mounts as a bottom-sheet Modal mirroring AddMealToPlanSheet's pattern:
// React Native built-in <Modal> + Pressable backdrop + safe-area-insets sheet.
//
// Renders a Template's title/description/tags/items so the user can see what
// they would be using before committing. The single CTA at the bottom of the
// ScrollView fires onUsePlan(templateId), then onClose().

import React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getTemplate, type TemplateDetail } from "@/lib/api/plans";

export interface PlanPreviewModalProps {
  visible: boolean;
  /** null when closed; non-null while open. */
  templateId: string | null;
  onClose: () => void;
  /** Use Plan tap — caller mutates and navigates. Receives templateId. */
  onUsePlan: (templateId: string) => void | Promise<void>;
}

export function PlanPreviewModal({
  visible,
  templateId,
  onClose,
  onUsePlan,
}: PlanPreviewModalProps) {
  const insets = useSafeAreaInsets();

  const query = useQuery<TemplateDetail>({
    queryKey: ["plans", "template", templateId ?? ""],
    queryFn: () => getTemplate(templateId as string),
    enabled: visible && !!templateId,
  });

  const handleUsePlan = async () => {
    if (!templateId) return;
    try {
      await onUsePlan(templateId);
    } finally {
      onClose();
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>
              {query.data?.title ?? "Plan preview"}
            </Text>
            {query.data?.defaultDaysCount ? (
              <Text style={s.subtitle}>
                {query.data.defaultDaysCount}{" "}
                {query.data.defaultDaysCount === 1 ? "day" : "days"}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} hitSlop={12} testID="plan-preview-close">
            <Feather name="x" size={22} color={KColors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {query.isLoading && (
            <View style={s.loadingBlock}>
              <ActivityIndicator color={KColors.sage[700]} />
            </View>
          )}

          {query.isError && (
            <Text style={s.errorText}>
              Couldn't load this plan. Try again.
            </Text>
          )}

          {query.data && (
            <>
              {query.data.description && (
                <Text style={s.description}>{query.data.description}</Text>
              )}

              {query.data.tags.length > 0 && (
                <View style={s.tagRow}>
                  {query.data.tags.map((tag) => (
                    <View key={tag} style={s.tagPill}>
                      <Text style={s.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              )}

              {query.data.optimizationNotes.length > 0 && (
                <View style={s.notesBlock}>
                  {query.data.optimizationNotes.map((note, i) => (
                    <Text key={i} style={s.noteText}>
                      • {note.text}
                    </Text>
                  ))}
                </View>
              )}

              <Text style={s.sectionTitle}>Meals</Text>
              <View style={s.itemList}>
                {query.data.items.length === 0 ? (
                  <Text style={s.emptyText}>
                    No meals in this plan yet.
                  </Text>
                ) : (
                  query.data.items.map((item) => (
                    <View key={item.id} style={s.itemRow}>
                      <View style={s.itemThumb}>
                        {/* D-WS6-043: image rendering deferred; placeholder block */}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.itemName} numberOfLines={1}>
                          {item.meal?.title ?? "Meal unavailable"}
                        </Text>
                        {item.assignedDayOfWeek && (
                          <Text style={s.itemDay}>{item.assignedDayOfWeek}</Text>
                        )}
                      </View>
                    </View>
                  ))
                )}
              </View>

              <Pressable
                onPress={handleUsePlan}
                style={({ pressed }) => [
                  s.cta,
                  pressed && { opacity: 0.85 },
                ]}
                testID="plan-preview-use"
              >
                <Text style={s.ctaText}>Use Plan</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "85%",
    backgroundColor: KColors.neutral[100],
    borderTopLeftRadius: KRadius.xl,
    borderTopRightRadius: KRadius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: KColors.neutral[400],
    alignSelf: "center",
    marginTop: KSpacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
    gap: KSpacing.sm,
  },
  title: {
    fontSize: KType.size.xl,
    fontWeight: KType.weight.bold,
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
  },
  loadingBlock: {
    paddingVertical: KSpacing.xl,
    alignItems: "center",
  },
  errorText: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingVertical: KSpacing.md,
  },
  description: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    marginBottom: KSpacing.md,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: KSpacing.sm,
    marginBottom: KSpacing.md,
  },
  tagPill: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 3,
    borderRadius: KRadius.pill,
    backgroundColor: KColors.sage[100],
  },
  tagText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontFamily: "Inter_600SemiBold",
  },
  notesBlock: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    marginBottom: KSpacing.md,
    gap: 4,
  },
  noteText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
  },
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  itemList: {
    gap: KSpacing.sm,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  itemThumb: {
    width: 44,
    height: 44,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[100],
  },
  itemName: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  itemDay: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  emptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: KSpacing.md,
  },
  cta: {
    marginTop: KSpacing.lg,
    backgroundColor: KColors.sage[700],
    paddingVertical: KSpacing.md,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  ctaText: {
    color: KColors.neutral[100],
    fontSize: KType.size.md,
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
});
