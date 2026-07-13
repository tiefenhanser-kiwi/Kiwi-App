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

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
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
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
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
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {query.isLoading && (
            <View style={s.loadingBlock}>
              <ActivityIndicator color={Colors.sage[700]} />
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
    backgroundColor: Palette.background.overlay,
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "85%",
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[400],
    alignSelf: "center",
    marginTop: Spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
    gap: Spacing[2],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  scrollContent: {
    padding: Spacing[4],
    paddingBottom: Spacing[8],
  },
  loadingBlock: {
    paddingVertical: Spacing[5],
    alignItems: "center",
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    paddingVertical: Spacing[3],
  },
  description: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[3],
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[2],
    marginBottom: Spacing[3],
  },
  tagPill: {
    paddingHorizontal: Spacing[2],
    paddingVertical: 3,
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[100],
  },
  tagText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
  },
  notesBlock: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.md,
    padding: Spacing[3],
    marginBottom: Spacing[3],
    gap: 4,
  },
  noteText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  itemList: {
    gap: Spacing[2],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[2],
  },
  itemThumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[100],
  },
  itemName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  itemDay: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  emptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: Spacing[3],
  },
  cta: {
    marginTop: Spacing[4],
    backgroundColor: Colors.sage[700],
    paddingVertical: Spacing[3],
    borderRadius: Radius.md,
    alignItems: "center",
  },
  ctaText: {
    color: Colors.neutral[100],
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[600],
  },
});
