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

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { getUserPlans } from "@/lib/stubs";
import type { UserPlanSummary } from "@/lib/types";

export interface AddMealToPlanSheetProps {
  visible: boolean;
  /** The meal being added. */
  mealId: string;
  /** Display name for the sheet header subtitle. */
  mealTitle?: string;
  onClose: () => void;
  /** Called when user picks an existing plan. */
  onPickExistingPlan: (plan: UserPlanSummary) => void;
}

function formatDateRange(start?: string, end?: string): string {
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

function statusLabel(status: UserPlanSummary["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "completed":
      return "Completed";
    case "draft":
      return "Draft";
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

  const plans = useMemo(
    () =>
      [...getUserPlans()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    [],
  );

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
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
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
            <Feather name="x" size={22} color={KColors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Section 1: pick an existing plan */}
          <Text style={s.sectionTitle}>Pick an existing plan</Text>
          <View style={s.list}>
            {plans.length === 0 ? (
              <Text style={s.emptyText}>
                You don't have any plans yet. Create your first one below.
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
                    <Text
                      style={s.planName}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {plan.name}
                    </Text>
                    {(plan.weekStartDate || plan.weekEndDate) && (
                      <Text style={s.planRange}>
                        {formatDateRange(
                          plan.weekStartDate,
                          plan.weekEndDate,
                        )}
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
                    <Text style={s.mealCount}>
                      {plan.mealCount} {plan.mealCount === 1 ? "meal" : "meals"}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
          </View>

          {/* Section 2: create a new plan */}
          <Text style={[s.sectionTitle, s.sectionGap]}>Create a new plan</Text>
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
                color={KColors.sage[700]}
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
              <ActivityIndicator size="small" color={KColors.sage[700]} />
            ) : (
              <Feather
                name="chevron-right"
                size={18}
                color={KColors.neutral[600]}
              />
            )}
          </Pressable>
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
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sectionGap: {
    marginTop: KSpacing.lg,
  },
  list: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  emptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: KSpacing.md,
  },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  planName: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  planRange: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  planRight: {
    alignItems: "flex-end",
    gap: 4,
  },
  statusPill: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 3,
    borderRadius: KRadius.pill,
  },
  statusActive: {
    backgroundColor: KColors.sage[200],
  },
  statusCompleted: {
    backgroundColor: KColors.neutral[300],
  },
  statusDraft: {
    backgroundColor: KColors.terracotta[200],
  },
  statusPillText: {
    fontSize: KType.size.xs,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  statusActiveText: {
    color: KColors.sage[700],
  },
  statusCompletedText: {
    color: KColors.neutral[800],
  },
  statusDraftText: {
    color: KColors.terracotta[700],
  },
  mealCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  newPlanCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    marginTop: KSpacing.sm,
  },
  newPlanIcon: {
    width: 36,
    height: 36,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  newPlanTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  newPlanSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
