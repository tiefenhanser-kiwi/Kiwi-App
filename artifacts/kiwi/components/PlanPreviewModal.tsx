// WS7-4-B c6 — Plan preview overlay for the Use Plan flow (PRD §9.2.5).
// Mounts as a bottom-sheet Modal mirroring AddMealToPlanSheet's pattern:
// React Native built-in <Modal> + Pressable backdrop + safe-area-insets sheet.
//
// Renders a Template so the user can see what they would be using before
// committing. WS9 3b-follow-up: two CTAs mirror the wizard's Plan Details
// choice — "Use This Week" (primary → create + activate this week) and "Save
// for Later" (secondary → create as an undated draft). Both fire
// onUsePlan(templateId, { activate }). The in-flight guard blocks a double-tap
// that would create two instances (the rail-dupe half of BUG-036).
//
// PREVIEW-1 — rebuilt to read like Plan Review, with real photos. Hans, on the
// live Featured rail (Oct 12): "this needs a little rework - making it more
// like the plan review screen". Top to bottom: the template's own cover
// (TemplateDetail.image, which the sheet never showed) through TreatedImage;
// Plan Review's sage header band with the title and one meta line; the
// description, tags, and Plan Review's Smart optimization card; the meals as
// read-only Plan-Review-shaped cards with photos (the D-WS6-043 placeholder
// block is gone — the photos were always on item.meal.image); the two CTAs
// pinned in a footer. A meal tap opens that meal IN the sheet
// (planPreview/PlanPreviewMealView explains why not a second Modal or a route).
//
// BUG-396 — a failed use used to close the sheet silently (try/finally, no
// catch). It now stays open, clears the pending state and says so inline; it
// closes only on success.

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

import { Card } from "@/components/Card";
import { DisplayTitle } from "@/components/DisplayTitle";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { getTemplate, type TemplateDetail } from "@/lib/api/plans";

import { PlanPreviewMealRow } from "./planPreview/PlanPreviewMealRow";
import { PlanPreviewMealView } from "./planPreview/PlanPreviewMealView";
import { buildPlanPreview, type PreviewMealRow } from "./planPreview/previewModel";
import { sheetHandleShown, webSheet } from "@/lib/webLayout";

// BUG-396 — the app's existing generic failure line (forgot/reset password,
// Meals tab, grocery list). Since PREVIEW-1 B only a failed CREATE reaches
// here (planPreview/previewUseFlow.ts): an activate failure after a successful
// create opens the plan with its own toast, so this retry never duplicates one.
export const PREVIEW_USE_ERROR = "Something went wrong. Please try again.";

export interface PlanPreviewModalProps {
  visible: boolean;
  /** null when closed; non-null while open. */
  templateId: string | null;
  onClose: () => void;
  /** Use-plan tap — caller creates the instance, activates this week iff
   *  opts.activate, and navigates. Receives templateId + the chosen intent.
   *  A throw / rejection keeps the sheet open with an inline error (BUG-396). */
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

  const model = React.useMemo(
    () => (query.data ? buildPlanPreview(query.data) : null),
    [query.data],
  );

  // Which CTA is mid-flight (null = idle). Guards a double-tap that would
  // otherwise fire onUsePlan twice → two instances (the rail-dupe half of
  // BUG-036). Both buttons disable while either is pending.
  const [pending, setPending] = React.useState<null | "use" | "save">(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // The meal opened in-sheet, or null for the plan view.
  const [openMeal, setOpenMeal] = React.useState<PreviewMealRow | null>(null);

  // The Modal stays mounted between opens (visible toggles), so per-open state
  // must be cleared when the template changes — including to null on close.
  React.useEffect(() => {
    setOpenMeal(null);
    setActionError(null);
  }, [templateId]);

  const handleAction = async (activate: boolean) => {
    if (!templateId || pending !== null) return;
    setPending(activate ? "use" : "save");
    setActionError(null);
    try {
      await onUsePlan(templateId, { activate });
    } catch (err) {
      // BUG-396 — stay open; the user can retry or dismiss.
      console.warn("[plan-preview] use failed", { templateId, activate, err });
      setPending(null);
      setActionError(PREVIEW_USE_ERROR);
      return;
    }
    setPending(null);
    onClose();
  };

  // Android back / web Escape: a meal view steps back to the plan first.
  const handleRequestClose = () => {
    if (openMeal) setOpenMeal(null);
    else onClose();
  };

  const data = query.data;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleRequestClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={webSheet(s.sheet)}>
        {sheetHandleShown() && <View style={s.handle} />}
        <View style={s.topBar}>
          {openMeal ? (
            <Pressable
              onPress={() => setOpenMeal(null)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back to the plan"
              style={({ pressed }) => [s.backLink, pressed && { opacity: 0.6 }]}
              testID="plan-preview-meal-back"
            >
              <Feather name="chevron-left" size={20} color={Colors.sage[700]} />
              <Text style={s.backLinkText}>Plan</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="plan-preview-close"
          >
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        {/* The plan scroll stays MOUNTED while a meal is open (hidden, not
            unmounted) so "‹ Plan" returns to the same scroll position. */}
        <ScrollView
          style={openMeal ? s.hidden : s.scroll}
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

          {data && model && (
            <>
              {/* The template's own cover — the photo the rail card showed,
                  at the rail card's crop. Null → the warm gradient. */}
              <TreatedImage
                source={data.image ? { uri: data.image } : null}
                aspectRatio={ImageTreatment.aspect.railCard}
                radius={Radius.lg}
                style={s.hero}
              />

              {/* Plan Review's header band (app/plan/[id].tsx s.headerBand):
                  the name alone on its row, then one meta line. */}
              <View style={s.headerBand}>
                <DisplayTitle
                  source={data}
                  variant="hero"
                  style={s.title}
                  fallback="Plan preview"
                />
                <Text style={s.metaText}>{model.metaLine}</Text>
              </View>

              {data.description ? (
                <Text style={s.description}>{data.description}</Text>
              ) : null}

              {data.tags.length > 0 && (
                <View style={s.tagRow}>
                  {data.tags.map((tag) => (
                    <View key={tag} style={s.tagPill}>
                      <Text style={s.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Plan Review §8.3.4 — the same Smart optimization card, hidden
                  when there are no notes. */}
              {data.optimizationNotes.length > 0 && (
                <View style={s.section}>
                  <Card>
                    <Text style={s.cardTitle}>Smart optimization</Text>
                    <View style={s.notes}>
                      {data.optimizationNotes.map((note, i) => (
                        <View key={i} style={s.noteRow}>
                          <Feather
                            name={note.type === "prep" ? "zap" : "dollar-sign"}
                            size={14}
                            color={Colors.sage[700]}
                          />
                          <Text style={s.noteText}>{note.text}</Text>
                        </View>
                      ))}
                    </View>
                  </Card>
                </View>
              )}

              <View style={s.section}>
                <Text style={s.sectionHeader}>Meals</Text>
                {model.scheduled.length === 0 && model.unscheduled.length === 0 ? (
                  <Text style={s.emptyText}>No meals in this plan yet.</Text>
                ) : (
                  <>
                    {model.scheduled.map((row) => (
                      <PlanPreviewMealRow key={row.itemId} row={row} onOpen={setOpenMeal} />
                    ))}
                    {model.unscheduled.length > 0 && (
                      <>
                        <Text style={s.subSectionHeader}>Unscheduled</Text>
                        {model.unscheduled.map((row) => (
                          <PlanPreviewMealRow key={row.itemId} row={row} onOpen={setOpenMeal} />
                        ))}
                      </>
                    )}
                  </>
                )}
              </View>
            </>
          )}
        </ScrollView>

        {openMeal && (
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <PlanPreviewMealView row={openMeal} />
          </ScrollView>
        )}

        {/* G2 — one primary. "Use This Week" (terracotta) is the committing
            action and the sheet's ONLY terracotta fill (D-WS9-162); "Save for
            Later" is the quiet secondary. Pinned below the scroll, so the
            decision is always in reach — from the meal view too. */}
        {data && (
          <View style={[s.footer, { paddingBottom: insets.bottom + Spacing[3] }]}>
            {actionError ? (
              <Text style={s.actionError} accessibilityRole="alert" testID="plan-preview-error">
                {actionError}
              </Text>
            ) : null}
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
        )}
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
    overflow: "hidden",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[400],
    alignSelf: "center",
    marginTop: Spacing[2],
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
    paddingBottom: Spacing[2],
  },
  backLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  backLinkText: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  scroll: {
    flex: 1,
  },
  hidden: {
    display: "none",
  },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingBottom: Spacing[5],
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
  hero: {
    marginBottom: Spacing[3],
  },
  // app/plan/[id].tsx s.headerBand + s.headerBandBody.
  headerBand: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[200],
    paddingHorizontal: Spacing[3],
    paddingVertical: 10,
    gap: 6,
    marginBottom: Spacing[3],
  },
  // app/plan/[id].tsx s.staticPlanName.
  title: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  // app/plan/[id].tsx s.mealCountText.
  metaText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  description: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
    marginBottom: Spacing[3],
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[2],
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
  section: {
    marginTop: Spacing[4],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  notes: {
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
  },
  noteText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  sectionHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  subSectionHeader: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[4],
    marginBottom: Spacing[2],
  },
  emptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: Spacing[3],
  },
  footer: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    gap: Spacing[2],
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    backgroundColor: Colors.neutral[100],
  },
  actionError: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.danger,
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
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
