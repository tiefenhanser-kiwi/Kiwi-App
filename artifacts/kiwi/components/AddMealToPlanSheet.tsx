import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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

export interface AddMealToPlanSheetProps {
  visible: boolean;
  /** The meal being added. */
  mealId: string;
  /** Display name for the sheet header subtitle. */
  mealTitle?: string;
  onClose: () => void;
  /** Called when user picks an existing plan. */
  onPickExistingPlan: (plan: PlanListItem) => void;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const s = new Date(start);
  const e = new Date(end);
  const sFormatted = s.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  if (start === end) return sFormatted;
  const eFormatted = e.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${sFormatted} – ${eFormatted}`;
}

function statusLabel(status: string | null): string {
  switch (status) {
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
  // WS9-2 2a Commit B — order most-recent-first by startDate. PlanListItem has
  // no createdAt, but startDate is already on the client (the row shows it), so
  // no server change. Undated drafts (null startDate) sort LAST — a dated plan
  // is the likely "add to which plan?" target.
  const plans = useMemo<PlanListItem[]>(() => {
    const rows = plansQuery.data?.plans ?? [];
    return [...rows].sort((a, b) => {
      if (a.startDate && b.startDate) return b.startDate.localeCompare(a.startDate);
      if (a.startDate) return -1;
      if (b.startDate) return 1;
      return 0;
    });
  }, [plansQuery.data]);

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
      Alert.alert(
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
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Add to plan</Text>
            {mealTitle && (
              <Text style={s.subtitle} numberOfLines={1}>
                {mealTitle}
              </Text>
            )}
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

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
                You don't have any plans yet. Create your first one above.
              </Text>
            ) : (
              plans.map((plan) => (
                <Pressable
                  key={plan.id}
                  onPress={() => {
                    onPickExistingPlan(plan);
                    onClose();
                  }}
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
                        plan.status === "active" && s.statusActive,
                        plan.status === "completed" && s.statusCompleted,
                        plan.status === "draft" && s.statusDraft,
                      ]}
                    >
                      <Text
                        style={[
                          s.statusPillText,
                          plan.status === "active" && s.statusActiveText,
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
    color: Colors.neutral[600],
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
