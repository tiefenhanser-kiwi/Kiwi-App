// /test-kitchen/plan — Row 13 · Block 2 Part D. The guest's plan.
//
// ⚠️ NOT app/plan/[id].tsx, AND THIS IS THE BLOCK'S LARGEST DEVIATION FROM THE
// BRIEF. Part D said "plan/[id] reads the guest draft via GET /guest/draft". It
// cannot, for two independent reasons found in the tree:
//
//   1. plan/[id].tsx reviews a SAVED plan. Its read is usePlan → GET /plans/:id
//      (requireAuth); its writes are patchPlan, compost, swap, add-meals, grocery
//      generate, date/name editors, macro recalc. A guest has no PlanInstance at
//      all — Phase 0 established that every plan table's userId is a NOT NULL FK
//      to users, which is exactly why the guest's plan lives as JSON on the
//      GuestSession row.
//   2. The draft-shaped branch plan/[id].tsx would have needed is GONE. It was
//      removed in D-WS9-191 §4.7 / lane-pfc Part C.3 ("the unsaved-draft branch
//      … is GONE from this screen"), and the only remaining consumer of
//      GET /wizard/drafts/:id is lib/api/wizard.ts's getWizardDraft, which today
//      has NO screen caller at all — only tests. The server's Block 1 comment
//      ("so the mobile draft screen renders a guest plan through the code path it
//      already has") describes a screen that no longer exists.
//
// So this is a new, small read-only screen over the same payload, and the
// view-model is lib/guest/guestPlanModel.ts (tested).
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Redirect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { GuestDoorSheet } from "@/components/GuestDoorSheet";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { TreatedImage } from "@/components/TreatedImage";
import {
  Colors,
  ImageTreatment,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { useGuest } from "@/contexts/GuestContext";
import { useGuestDoor } from "@/hooks/useGuestDoor";
import { getGuestDraft, getGuestSession, trackGuestEvent } from "@/lib/api/guest";
import { guestPlanRows, guestPlanSubline } from "@/lib/guest/guestPlanModel";
import { goBack } from "@/lib/navigation";

export const GUEST_PLAN_SAVE_CTA = "Save this plan to my account";
export const GUEST_PLAN_READ_NOTE =
  "Read anything here. Saving, editing and the grocery list live in your account.";
export const GUEST_PLAN_GONE =
  "Kiwi does not have this plan any more. Start a fresh Test Kitchen session to build a week.";

// Resub C1 — no platform redirect: the Test Kitchen runs on native too.
export default function GuestPlanRoute() {
  return <GuestPlanScreen />;
}

function GuestPlanScreen() {
  const router = useRouter();
  const { session, generation, pickedMealImages } = useGuest();
  const guestDoor = useGuestDoor();

  const draftQuery = useQuery({
    queryKey: ["guest", "draft", session?.guestSessionId ?? null],
    queryFn: getGuestDraft,
    enabled: !!session,
  });

  // Resub C4 (BUG-366) — the three-plan path's cards, for the row thumbnails
  // (lib/guest/guestPlanModel.ts). The same read the entry and the options
  // screen make, under the same key, so it is usually already cached — and it is
  // the one copy that survives a reload. Never a per-row GET /meals/:id.
  const sessionQuery = useQuery({
    queryKey: ["guest", "session", session?.guestSessionId ?? null],
    queryFn: getGuestSession,
    enabled: !!session && !generation,
  });

  const expanded = draftQuery.data?.expanded ?? null;
  const rows = expanded
    ? guestPlanRows(expanded, {
        candidates: generation?.candidates ?? sessionQuery.data?.candidates ?? null,
        pickedMealImages,
      })
    : [];

  React.useEffect(() => {
    if (expanded) void trackGuestEvent("plan_opened", { step: "plan_screen" });
  }, [expanded]);

  if (!session) return <Redirect href="/test-kitchen" />;

  return (
    <View style={s.screen}>
      <Header
        showBack
        onBack={() => goBack(router, "/test-kitchen")}
        title={expanded?.title ?? "Your plan"}
        subtitle={expanded ? guestPlanSubline(expanded) : undefined}
      />
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {draftQuery.isLoading ? <LoadingShim variant="inline" label="Opening your plan…" /> : null}

        {draftQuery.isError ? (
          <View style={s.statusCard}>
            <Text style={s.statusTitle}>That plan is gone</Text>
            <Text style={s.statusBody}>{GUEST_PLAN_GONE}</Text>
            <Button
              label="Back to the Test Kitchen"
              variant="primary"
              onPress={() => router.replace("/test-kitchen")}
            />
          </View>
        ) : null}

        {expanded ? (
          <>
            {expanded.tags.length > 0 ? (
              <View style={s.tagRow}>
                {expanded.tags.map((t) => (
                  <View key={t} style={s.tag}>
                    <Text style={s.tagText}>{t}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {expanded.whyBullets.length > 0 ? (
              <View style={s.why}>
                <Text style={s.whyLabel}>Why this week</Text>
                {expanded.whyBullets.map((b, i) => (
                  <View key={i} style={s.whyRow}>
                    <View style={s.whyDot} />
                    <Text style={s.whyText}>{b}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* R4 — every write is a door. One honest line saying so, above the
                doors, rather than a disabled toolbar the visitor has to poke. */}
            <Text style={s.readNote}>{GUEST_PLAN_READ_NOTE}</Text>

            <View style={s.rows}>
              {rows.map((row) => (
                <Pressable
                  key={row.key}
                  // R4 — a READ. `attempt` is not needed: open_recipe is
                  // `write: false`, so the guard would allow it; going straight
                  // to the route keeps the read path free of the door machinery.
                  onPress={() => {
                    if (!row.recipeReadable) return;
                    router.push({
                      pathname: "/test-kitchen/recipe",
                      params: { mealId: row.recipeMealId!, key: row.key },
                    });
                  }}
                  style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
                >
                  {/* BUG-366 — the member plan row's thumb (PlanReviewMealRow:
                      TreatedImage at the row role). Only when there is an
                      image: a null keeps the row exactly as it was. */}
                  {row.imageUrl ? (
                    <TreatedImage
                      source={{ uri: row.imageUrl }}
                      width={ImageTreatment.thumb.row}
                      height={ImageTreatment.thumb.row}
                      radius={Radius.md}
                    />
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowTitle}>{row.title}</Text>
                    {row.description ? (
                      <Text style={s.rowDescription} numberOfLines={3}>
                        {row.description}
                      </Text>
                    ) : null}
                    <Text style={s.rowMeta}>
                      {[
                        row.timeLabel,
                        `${row.servings} servings`,
                        row.caloriesPerServing
                          ? `${row.caloriesPerServing} cal/serving`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  {row.recipeReadable ? (
                    <Feather name="chevron-right" size={20} color={Colors.sage[700]} />
                  ) : null}
                </Pressable>
              ))}
            </View>

            {/* The doors, as real CTAs rather than hidden affordances: a visitor
                should be able to SEE that the grocery list exists. */}
            <View style={s.doors}>
              <Button
                label={GUEST_PLAN_SAVE_CTA}
                variant="primary"
                onPress={() => guestDoor.open("save_plan")}
                testID="guest-plan-save"
              />
              <Button
                label="Grocery list"
                variant="ghost"
                onPress={() => guestDoor.open("grocery_list")}
                testID="guest-plan-grocery"
              />
              <Button
                label="Order online"
                variant="ghost"
                onPress={() => guestDoor.open("order_online")}
                testID="guest-plan-order"
              />
              <Button
                label="Prep & Cook"
                variant="ghost"
                onPress={() => guestDoor.open("prep_cook")}
                testID="guest-plan-prep"
              />
              <Button
                label="Swap or add meals"
                variant="ghost"
                onPress={() => guestDoor.open("swap_meal")}
                testID="guest-plan-swap"
              />
            </View>
          </>
        ) : null}
      </ScrollView>
      <GuestDoorSheet action={guestDoor.door} onClose={guestDoor.close} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.neutral[100] },
  scroll: { padding: Spacing[4], paddingBottom: Spacing[8], gap: Spacing[3] },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing[2] },
  tag: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  tagText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  why: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    gap: Spacing[2],
  },
  whyLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  whyRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing[2] },
  whyDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.sage[700],
    marginTop: 7,
  },
  whyText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  readNote: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  rows: { gap: Spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
  },
  rowTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[600],
  },
  rowDescription: {
    marginTop: 2,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  rowMeta: {
    marginTop: 4,
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  doors: { gap: Spacing[2], marginTop: Spacing[2] },
  statusCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[3],
  },
  statusTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  statusBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
