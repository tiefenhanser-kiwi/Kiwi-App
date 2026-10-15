import React, { useEffect, useMemo, useState } from "react";
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
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DisplayTitle } from "@/components/DisplayTitle";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { usePlans } from "@/hooks/usePlans";
import type { PlanListItem } from "@/lib/api/plans";
import { todayLocalDate } from "@/lib/dates";
import {
  livePlans,
  planDayOptions,
  type PlanDayOption,
} from "@/lib/plans/addToPlanTargets";
import { formatPlanDateRange } from "@/lib/plans/planRowMeta";
import { dialog } from "@/lib/dialog";
import type { DayOfWeek } from "@/lib/types";

export interface AddMealToPlanSheetProps {
  visible: boolean;
  /** The meal being added. */
  mealId: string;
  /** Display name for the sheet header subtitle. */
  mealTitle?: string;
  onClose: () => void;
  /**
   * Called when the user picks an existing plan AND a day (BOOK-1C1: the day
   * step). The sheet lists live plans only — active and upcoming
   * (lib/plans/addToPlanTargets.ts) — so the pick can never be a composted
   * plan's 409.
   */
  onPickExistingPlan: (plan: PlanListItem, day: DayOfWeek) => void;
}

// BUG-293 — this used to parse the plan's YYYY-MM-DD with new Date() (UTC
// midnight) and format it locally, so west of UTC the row read a day early.
// Same shape as the My Plans meta line (Block 3, planRowMeta.ts): parseLocalDate
// underneath, "Sep 16 – Sep 21", one day collapses to "Sep 16". Not a third
// date path.
export function formatDateRange(start: string | null, end: string | null): string {
  return formatPlanDateRange(start, end) ?? "";
}

function statusLabel(status: string | null): string {
  switch (status) {
    // BOOK-1C1 — the live list's real PlanStatus values (they read "Plan").
    case "this_week":
      return "This week";
    case "next_week":
      return "Next week";
    case "upcoming":
      return "Upcoming";
    case "active":
      return "Active";
    case "completed":
      return "Completed";
    case "draft":
      return "Draft";
    default:
      return "Plan";
  }
}

export function AddMealToPlanSheet({
  visible,
  mealId,
  mealTitle,
  onClose,
  onPickExistingPlan,
}: AddMealToPlanSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { createPlanWithMeal } = useApp();
  const [creating, setCreating] = useState(false);

  // WS9-2 BUG-070 — the "Pick an existing plan" list now reads the real saved
  // plans (usePlans(["my_plans"]), the same query the Home Plan Discovery card
  // + Plans tab use) instead of the three hardcoded getUserPlans() demo rows.
  // The GET /plans list payload (PlanListItem) carries no per-plan meal count,
  // so the row no longer shows a "N meals" badge.
  const plansQuery = usePlans(["my_plans"]);
  // BOOK-1C1 — live plans only (active + upcoming), soonest first. This
  // replaced WS9-2 2a Commit B's most-recent-first sort over EVERY plan: past
  // plans and undated drafts are no longer offered (addToPlanTargets.ts says
  // why), and with only live plans left the active one belongs at the top.
  const plans = useMemo<PlanListItem[]>(
    () => livePlans(plansQuery.data?.plans ?? [], todayLocalDate()),
    [plansQuery.data],
  );

  // BOOK-1C1 — the day step: a picked plan, then its days.
  const [pickedPlan, setPickedPlan] = useState<PlanListItem | null>(null);
  const dayOptions = useMemo<PlanDayOption[]>(
    () => (pickedPlan ? planDayOptions(pickedPlan) : []),
    [pickedPlan],
  );
  // Every opening starts on the plan step.
  useEffect(() => {
    if (!visible) setPickedPlan(null);
  }, [visible]);

  // WS7-5b-mobile Block C — D-WS7-059 real wiring. Replaces the prior stub
  // that deep-linked to `demo-plan-just-created` with `addMealId=` (a dead
  // path in production). New flow: POST /plans → POST /plans/:id/items →
  // navigate to Plan Review (per Hans's ruling, the destination is Plan
  // Review so the user immediately sees the new plan with its one meal).
  // Partial-failure handling: if POST /plans succeeds but the meal-add
  // throws, the empty plan stays (MVP — no cleanup); we alert and leave the
  // user on the calling screen so they can find the empty plan in My Plans.
  const handleCreateNewPlan = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { planId } = await createPlanWithMeal(mealId);
      onClose();
      setTimeout(() => {
        router.push({ pathname: "/plan/[id]", params: { id: planId } });
      }, 150);
    } catch (err) {
      console.warn("[AddMealToPlanSheet] create-plan-with-meal failed", {
        mealId,
        err,
      });
      dialog.alert(
        "Couldn't create plan",
        "Something went wrong. If a partial plan was created, you'll find it in your plans list.",
      );
    } finally {
      setCreating(false);
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
          {pickedPlan ? (
            <Pressable
              onPress={() => setPickedPlan(null)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back to plans"
            >
              <Feather name="chevron-left" size={22} color={Colors.neutral[800]} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={s.title}>{pickedPlan ? "Pick a day" : "Add to plan"}</Text>
            {pickedPlan ? (
              <DisplayTitle source={pickedPlan} variant="slim" style={s.subtitle} />
            ) : (
              mealTitle && (
                <Text style={s.subtitle} numberOfLines={1}>
                  {mealTitle}
                </Text>
              )
            )}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        {pickedPlan ? (
          <ScrollView
            contentContainerStyle={s.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={s.list}>
              {dayOptions.map((opt) => (
                <Pressable
                  key={opt.day}
                  onPress={() => {
                    const plan = pickedPlan;
                    onClose();
                    onPickExistingPlan(plan, opt.day);
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [s.planRow, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[s.planName, { flex: 1 }]}>{opt.label}</Text>
                  <Feather name="chevron-right" size={18} color={Colors.neutral[600]} />
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* WS9-2 2a device-fix — "Create a new plan" sits ABOVE the plans list
              so it stays reachable as plans accumulate (the list is unbounded, and
              a card below it gets pushed out of reach). */}
          <Text style={s.sectionTitle}>Create a new plan</Text>
          <Pressable
            onPress={handleCreateNewPlan}
            disabled={creating}
            style={({ pressed }) => [
              s.newPlanCard,
              (pressed || creating) && { opacity: 0.7 },
            ]}
          >
            <View style={s.newPlanIcon}>
              <Feather
                name="plus-square"
                size={20}
                color={Colors.sage[700]}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.newPlanTitle}>
                {creating ? "Creating plan…" : "Create a new plan"}
              </Text>
              <Text style={s.newPlanSubtitle}>
                Start a new plan with this meal
              </Text>
            </View>
            {creating ? (
              <ActivityIndicator size="small" color={Colors.sage[700]} />
            ) : (
              <Feather
                name="chevron-right"
                size={18}
                color={Colors.neutral[600]}
              />
            )}
          </Pressable>

          {/* Pick an existing plan — the list lives BELOW the create card. */}
          <Text style={[s.sectionTitle, s.sectionGap]}>Pick an existing plan</Text>
          <View style={s.list}>
            {plansQuery.isLoading ? (
              <Text style={s.emptyText}>Loading…</Text>
            ) : plansQuery.isError ? (
              <Text style={s.emptyText}>
                Couldn't load your plans right now. Try again in a moment.
              </Text>
            ) : plans.length === 0 ? (
              <Text style={s.emptyText}>
                You don't have an active or upcoming plan. Create one above.
              </Text>
            ) : (
              plans.map((plan) => (
                <Pressable
                  key={plan.id}
                  // BOOK-1C1 — a plan pick opens the day step; the sheet hands
                  // back (plan, day) from there.
                  onPress={() => setPickedPlan(plan)}
                  style={({ pressed }) => [
                    s.planRow,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <DisplayTitle
                      source={plan}
                      variant="slim"
                      style={s.planName}
                    />
                    {(plan.startDate || plan.endDate) && (
                      <Text style={s.planRange}>
                        {formatDateRange(plan.startDate, plan.endDate)}
                      </Text>
                    )}
                  </View>
                  <View style={s.planRight}>
                    <View
                      style={[
                        s.statusPill,
                        (plan.status === "active" || plan.status === "this_week") &&
                          s.statusActive,
                        plan.status === "completed" && s.statusCompleted,
                        plan.status === "draft" && s.statusDraft,
                      ]}
                    >
                      <Text
                        style={[
                          s.statusPillText,
                          (plan.status === "active" || plan.status === "this_week") &&
                            s.statusActiveText,
                          plan.status === "completed" &&
                            s.statusCompletedText,
                          plan.status === "draft" && s.statusDraftText,
                        ]}
                      >
                        {statusLabel(plan.status)}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              ))
            )}
          </View>
        </ScrollView>
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
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sectionGap: {
    marginTop: Spacing[4],
  },
  list: {
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  emptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: Spacing[3],
  },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  planName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  planRange: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  planRight: {
    alignItems: "flex-end",
    gap: 4,
  },
  statusPill: {
    paddingHorizontal: Spacing[2],
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  statusActive: {
    backgroundColor: Colors.sage[200],
  },
  statusCompleted: {
    backgroundColor: Colors.neutral[300],
  },
  statusDraft: {
    backgroundColor: Colors.terracotta[200],
  },
  statusPillText: {
    fontSize: Typography.fontSize.xs,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  statusActiveText: {
    color: Colors.sage[700],
  },
  statusCompletedText: {
    color: Colors.neutral[800],
  },
  statusDraftText: {
    color: Colors.terracotta[700],
  },
  mealCount: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  newPlanCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    marginTop: Spacing[2],
  },
  newPlanIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  newPlanTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  newPlanSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
});
