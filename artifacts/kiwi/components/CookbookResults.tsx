// BOOK-1C1 (D-WS9-312) — the Cookbook's result list, shared by the Cookbook
// screen (app/cookbook.tsx) and a season's collection view
// (app/cookbook-season.tsx).
//
// Owns everything a card leads to, so both hosts behave identically:
//   • tap → the existing meal detail;
//   • Save → AppContext.setSaved (the one save write) + a toast on tap;
//   • +   → AddMealToPlanSheet (live plans, then a day) → addMealToPlan;
//   • the end of every list → the Ask Kiwi helper; an empty result → "No meals
//     match these filters", Clear filters (when any are on), and the helper.
// Infinite scroll on the cursor (onEndReached at half a viewport, the Meals
// tab's Hans-ruled threshold).

import React, { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { AddMealToPlanSheet } from "@/components/AddMealToPlanSheet";
import { AskKiwiHelper } from "@/components/AskKiwiHelper";
import { CookbookCard } from "@/components/CookbookCard";
import { resolveDisplayTitle } from "@/components/DisplayTitle";
import { Colors, Spacing, Typography } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { useToast } from "@/contexts/ToastProvider";
import type { useCookbookMeals } from "@/hooks/useCookbook";
import type { CookbookMeal } from "@/lib/api/cookbook";
import { ApiError } from "@/lib/api/errors";
import { saveToastMessage } from "@/lib/cookbook/saveChip";
import { dialog } from "@/lib/dialog";

/** The web column: cards stop growing past a readable width. */
export const COOKBOOK_MAX_WIDTH = 640;

/**
 * BOOK-1C2 — how far the previous filters' cards (and count) fade while the
 * new filters load: still readable, plainly not the answer.
 */
export const UPDATING_OPACITY = 0.45;

export interface CookbookResultsProps {
  results: ReturnType<typeof useCookbookMeals>;
  header: React.ReactElement;
  /** The search text: the helper's prefill. */
  searchText: string;
  /** Shown in the empty state when filters are on. */
  onClearFilters?: () => void;
  /** Extra bottom padding (a host's fixed bottom bar). */
  bottomInset?: number;
}

export function CookbookResults({
  results,
  header,
  searchText,
  onClearFilters,
  bottomInset = 0,
}: CookbookResultsProps) {
  const router = useRouter();
  const { setSaved, addMealToPlan } = useApp();
  const { showToast, hideToast } = useToast();
  const [addFor, setAddFor] = useState<CookbookMeal | null>(null);

  const open = (meal: CookbookMeal) =>
    router.push({ pathname: "/meal/[id]", params: { id: meal.id } });

  // BOOK-1C2 — the toast shows ON TAP, with the chip's own (optimistic) flip,
  // not after the round trip ("a beat late"); a failure replaces it.
  const toggleSave = (meal: CookbookMeal) => {
    const next = !meal.isSaved;
    showToast({ message: saveToastMessage(next) });
    void setSaved(meal.id, next).catch(() =>
      showToast({ message: "Couldn't update My Meals. Please try again." }),
    );
  };

  const { meals } = results;
  const showHelperAtEnd = meals.length > 0 && !results.hasNextPage && !results.isFetchingNextPage;

  return (
    <>
      <AddMealToPlanSheet
        visible={addFor !== null}
        mealId={addFor?.id ?? ""}
        mealTitle={addFor ? resolveDisplayTitle(addFor) : undefined}
        onClose={() => setAddFor(null)}
        onPickExistingPlan={(plan, day) => {
          const meal = addFor;
          setAddFor(null);
          if (!meal) return;
          // BOOK-1C2 — on tap, as the save toast; a failure takes it down
          // before the alert says so.
          showToast({ message: `Added to ${resolveDisplayTitle(plan)} · ${day}` });
          void addMealToPlan(plan.id, meal.id, day)
            .catch((err: unknown) => {
              hideToast();
              console.warn("[cookbook] add-to-plan failed", { planId: plan.id, mealId: meal.id, err });
              // BUG-411 — a plan composted elsewhere since the list loaded.
              const closed = err instanceof ApiError && err.status === 409;
              dialog.alert(
                "Couldn't add to plan",
                closed
                  ? "That plan was composted. Pick another plan."
                  : "Something went wrong. Please try again.",
              );
            });
        }}
      />
      <FlatList<CookbookMeal>
        style={s.flex1}
        contentContainerStyle={[s.content, { paddingBottom: Spacing[8] + bottomInset }]}
        data={meals}
        // The cards re-render when the held result starts or stops updating.
        extraData={results.updating}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          // BOOK-1C2 — the previous filters' cards, dimmed until the new
          // filters' own response lands (lib/cookbook/resultQuery.ts).
          <View style={results.updating ? s.updating : null}>
            <CookbookCard meal={item} onOpen={open} onToggleSave={toggleSave} onAddToPlan={setAddFor} />
          </View>
        )}
        ItemSeparatorComponent={() => <View style={s.gap} />}
        // BOOK-1C2 (item 4b) — Hans, on the Pixel: after a fast fling the
        // photos stayed blank until the cards were scrolled away and back. On
        // Android, and only there, FlatList defaults removeClippedSubviews to
        // true (react-native/Libraries/Lists/FlatList.js:162-166): a rendered
        // card outside the viewport is DETACHED from the native view tree, and
        // a fling mounts cards while they are off screen, so their photos
        // start, and land, on detached views. Web has no such clipping, and
        // there the same fling loads every photo in place (measured: all
        // on-screen cards "loaded" 4 s after the fling, no scroll-back). Off:
        // virtualization still unmounts cards far from the viewport, so
        // memory stays bounded; what goes is the attach/detach churn.
        removeClippedSubviews={false}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          // An empty HELD result is the old filters' "no meals", not this one's.
          results.isLoading || results.updating ? (
            <View style={s.state}>
              <ActivityIndicator color={Colors.sage[700]} />
            </View>
          ) : results.isError ? (
            <Text style={s.stateText}>Couldn’t load the Cookbook right now. Try again in a moment.</Text>
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>No meals match these filters</Text>
              {onClearFilters ? (
                <Pressable onPress={onClearFilters} accessibilityRole="button" style={s.clearBtn}>
                  <Text style={s.clearText}>Clear filters</Text>
                </Pressable>
              ) : null}
              <View style={s.helperGap}>
                <AskKiwiHelper searchText={searchText} />
              </View>
            </View>
          )
        }
        ListFooterComponent={
          results.isFetchingNextPage ? (
            <View style={s.state}>
              <ActivityIndicator size="small" color={Colors.sage[700]} />
            </View>
          ) : showHelperAtEnd ? (
            <View style={s.helperGap}>
              <AskKiwiHelper searchText={searchText} />
            </View>
          ) : null
        }
      />
    </>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  content: {
    width: "100%",
    maxWidth: COOKBOOK_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  gap: { height: Spacing[4] },
  updating: { opacity: UPDATING_OPACITY },
  state: { paddingVertical: Spacing[5], alignItems: "center" },
  stateText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    paddingVertical: Spacing[5],
  },
  empty: { paddingTop: Spacing[5], alignItems: "stretch" },
  emptyTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
    textAlign: "center",
  },
  clearBtn: { alignSelf: "center", paddingVertical: Spacing[2], paddingHorizontal: Spacing[3], marginTop: Spacing[1] },
  clearText: {
    fontSize: Typography.fontSize.base,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
    textDecorationLine: "underline",
  },
  helperGap: { marginTop: Spacing[5] },
});
