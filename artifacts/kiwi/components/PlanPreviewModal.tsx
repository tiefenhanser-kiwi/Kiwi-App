// WS7-4-B c6 — Plan preview overlay for the Use Plan flow (PRD §9.2.5).
// Mounts as a bottom-sheet Modal mirroring AddMealToPlanSheet's pattern:
// React Native built-in <Modal> + Pressable backdrop + safe-area-insets sheet.
//
// Renders a Template's title/description/tags/items so the user can see what
// they would be using before committing. WS9 3b-follow-up: two CTAs at the
// bottom mirror the wizard's Plan Details choice — "Use This Week" (primary →
// create + activate this week) and "Save for Later" (secondary → create as an
// undated draft). Both fire onUsePlan(templateId, { activate }), then
// onClose(). The in-flight guard blocks a double-tap that would create two
// instances (the rail-dupe half of BUG-036).

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

import { DisplayTitle } from "@/components/DisplayTitle";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { getTemplate, type TemplateDetail } from "@/lib/api/plans";

export interface PlanPreviewModalProps {
  visible: boolean;
  /** null when closed; non-null while open. */
  templateId: string | null;
  onClose: () => void;
  /** Use-plan tap — caller creates the instance, activates this week iff
   *  opts.activate, and navigates. Receives templateId + the chosen intent. */
  onUsePlan: (
    templateId: string,
    opts: { activate: boolean },
  ) => void | Promise<void>;
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

  // Which CTA is mid-flight (null = idle). Guards a double-tap that would
  // otherwise fire onUsePlan twice → two instances (the rail-dupe half of
  // BUG-036). Both buttons disable while either is pending.
  const [pending, setPending] = React.useState<null | "use" | "save">(null);

  const handleAction = async (activate: boolean) => {
    if (!templateId || pending !== null) return;
    setPending(activate ? "use" : "save");
    try {
      await onUsePlan(templateId, { activate });
    } finally {
      setPending(null);
      onClose();
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <DisplayTitle
              source={query.data}
              variant="slim"
              style={s.title}
              fallback="Plan preview"
            />
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
                        <DisplayTitle
                          source={item.meal}
                          variant="row"
                          style={s.itemName}
                          fallback="Meal unavailable"
                        />
                        {item.assignedDayOfWeek && (
                          <Text style={s.itemDay}>{item.assignedDayOfWeek}</Text>
                        )}
                      </View>
                    </View>
                  ))
                )}
              </View>

              {/* G2 — one primary. "Use This Week" (terracotta) is the
                  committing action; "Save for Later" is the quiet secondary. */}
              <View style={s.ctaWrap}>
                <Pressable
                  onPress={() => handleAction(true)}
                  disabled={pending !== null}
                  style={({ pressed }) => [
                    s.ctaPrimary,
                    pressed && { opacity: 0.85 },
                    pending !== null && { opacity: 0.6 },
                  ]}
                  testID="plan-preview-use"
                >
                  {pending === "use" ? (
                    <ActivityIndicator color={Palette.button.primary.text} />
                  ) : (
                    <Text style={s.ctaPrimaryText}>Use This Week</Text>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => handleAction(false)}
                  disabled={pending !== null}
                  style={({ pressed }) => [
                    s.ctaSecondary,
                    pressed && { opacity: 0.85 },
                    pending !== null && { opacity: 0.6 },
                  ]}
                  testID="plan-preview-save"
                >
                  {pending === "save" ? (
                    <ActivityIndicator color={Palette.button.secondary.text} />
                  ) : (
                    <Text style={s.ctaSecondaryText}>Save for Later</Text>
                  )}
                </Pressable>
              </View>
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
    fontFamily: Typography.face.serif[700],
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
  ctaWrap: {
    marginTop: Spacing[4],
    gap: Spacing[2],
  },
  ctaPrimary: {
    backgroundColor: Palette.button.primary.background,
    paddingVertical: 14,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaPrimaryText: {
    color: Palette.button.primary.text,
    fontSize: Typography.fontSize.lg,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  ctaSecondary: {
    backgroundColor: Palette.button.secondary.background,
    borderWidth: 1,
    borderColor: Palette.button.secondary.border,
    paddingVertical: 14,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaSecondaryText: {
    color: Palette.button.secondary.text,
    fontSize: Typography.fontSize.lg,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
