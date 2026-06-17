import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LoadingShim } from "@/components/LoadingShim";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useFindSimilarMeals } from "@/hooks/useFindSimilarMeals";
import { useMeal } from "@/hooks/useMeal";
import { useMeals } from "@/hooks/useMeals";
import type {
  MealCandidatePayload,
  MealDetail,
  MealFilterKey,
} from "@/lib/api/meals";
import { mealListItemToSummary } from "@/lib/plans/mealListItemToSummary";
import type { MealSummary } from "@/lib/types";

// All four catalog buckets in one request. The server unions per-filter
// result blocks and dedupes by id (artifacts/api-server/src/routes/me.ts:
// MEALS_FILTER_KEYS handling); React Query caches under the multi-key array.
const FIND_SIMILAR_BUCKETS: readonly MealFilterKey[] = [
  "my_meals",
  "featured",
  "top_rated",
  "hosting",
];

// MealListItem (GET /me/meals) has no mealType column, so candidate payloads
// can't carry a real per-meal type the way the source (MealDetail) does. A
// uniform placeholder keeps the required AI field populated without inventing a
// discriminating signal. D-WS7-146 tracks widening the list shape to carry it.
const CANDIDATE_MEAL_TYPE = "dinner";

// MealDetail -> MealCandidatePayload (only the 5 AI-relevant fields). The
// existing mealSummaryToCandidate helper in lib/api/meals.ts works on
// MealSummary; for the source-meal payload we read directly from MealDetail
// (id / title / cuisine / mealType / tags) without round-tripping through
// MealSummary. Server `cuisine` is always a string ("" if none) — empty
// narrows to null per the AI candidate schema.
function mealDetailToCandidate(meal: MealDetail): MealCandidatePayload {
  return {
    id: meal.id,
    title: meal.title,
    cuisine: meal.cuisine.length > 0 ? meal.cuisine : null,
    mealType: meal.mealType,
    tags: meal.tags,
  };
}

export interface FindSimilarSheetProps {
  visible: boolean;
  /** The source meal being matched against. */
  sourceMealId: string;
  /** Display name for the sheet header subtitle. */
  sourceMealTitle?: string;
  /** Source cuisine for the sheet header subtitle. */
  sourceCuisine?: string;
  onClose: () => void;
  /** Called when user picks a similar meal. */
  onPickReplacement: (newMeal: MealSummary) => void;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function FindSimilarSheet({
  visible,
  sourceMealId,
  sourceCuisine,
  onClose,
  onPickReplacement,
}: FindSimilarSheetProps) {
  const insets = useSafeAreaInsets();
  const [sortKey, setSortKey] = useState<SortKey>("alpha");
  const [aiOrderedIds, setAiOrderedIds] = useState<string[] | null>(null);
  const [hadError, setHadError] = useState(false);

  const findSimilarMutation = useFindSimilarMeals();

  // WS7-3 C4 c4 — candidate pool now comes from a single multi-filter
  // useMeals call; the server unions the four bucket queries and dedupes
  // by id (lib/api/meals.ts:204-208). One round-trip, one cache entry.
  // `enabled` defers fetching until the sheet is opened — closed sheet
  // shouldn't drive a list read.
  const candidatesQuery = useMeals(FIND_SIMILAR_BUCKETS);

  // Source-meal lookup — replaces the synchronous getMealById(sourceMealId)
  // with the real GET /meals/:id read. The AI payload uses meal.cuisine /
  // meal.mealType / meal.tags directly from MealDetail; the per-item source
  // field on the candidates is "saved" as a sensible default since the
  // multi-filter query doesn't carry per-meal provenance.
  const sourceMealQuery = useMeal(sourceMealId);
  const sourceMeal = sourceMealQuery.data;

  const candidatePool = useMemo<MealSummary[]>(() => {
    if (!sourceMealId || !candidatesQuery.data) return [];
    return candidatesQuery.data.meals
      .map((m) => mealListItemToSummary(m, "my_meals"))
      .filter((m) => m.id !== sourceMealId);
  }, [candidatesQuery.data, sourceMealId]);

  // Fire the AI call when the sheet opens with a fresh source AND both reads
  // have landed (source detail + candidate pool). Reset state each time so
  // re-opening for a different meal doesn't leak prior matches.
  useEffect(() => {
    if (!visible) {
      setAiOrderedIds(null);
      setHadError(false);
      findSimilarMutation.reset();
      return;
    }
    if (!sourceMeal || !candidatesQuery.data) {
      // Still waiting for source + candidates — the loading UX renders.
      return;
    }
    setAiOrderedIds(null);
    setHadError(false);
    findSimilarMutation.mutate(
      {
        source: mealDetailToCandidate(sourceMeal),
        // Candidates map straight off the GET /me/meals rows (not the
        // MealSummary pool) so real `tags` survive into the AI payload — the
        // MealSummary adapter drops them. `mealType` has no column in the list
        // shape, so it uses the uniform CANDIDATE_MEAL_TYPE placeholder; the
        // source carries its real mealType via MealDetail.
        candidates: candidatesQuery.data.meals
          .filter((m) => m.id !== sourceMealId)
          .map((m) => ({
            id: m.id,
            title: m.title,
            cuisine: m.cuisine.length > 0 ? m.cuisine : null,
            mealType: CANDIDATE_MEAL_TYPE,
            tags: m.tags,
          })),
        limit: 10,
      },
      {
        onSuccess: (data) => {
          setAiOrderedIds(data.matches.map((m) => m.mealId));
          setHadError(false);
        },
        onError: () => {
          setHadError(true);
        },
      },
    );
    // Intentionally only re-fire when the visible/source/data-arrival
    // transitions change — candidatePool churn would loop the effect that
    // owns the AI call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sourceMealId, sourceMeal, candidatesQuery.data]);

  // Build the rendered list from the AI's score order, unless the user picked a
  // different sort. There is no client-side fallback ranking on AI hard-failure
  // — the error state renders instead (see hadError). The server's free-tier
  // cuisine fallback arrives in-band as a normal `matches` response, so it
  // flows through this same AI path without branching.
  const matches = useMemo<MealSummary[]>(() => {
    if (!sourceMealId || !aiOrderedIds) return [];
    const byId = new Map(candidatePool.map((m) => [m.id, m]));
    const ordered = aiOrderedIds
      .map((id) => byId.get(id))
      .filter((m): m is MealSummary => !!m);
    return sortKey === "alpha" ? ordered : sortMeals(ordered, sortKey);
  }, [sourceMealId, aiOrderedIds, sortKey, candidatePool]);

  // Show the loading shim while the AI call is in flight OR while the
  // underlying source + candidates reads haven't both landed yet.
  const isLoading =
    findSimilarMutation.isPending ||
    (visible &&
      !!sourceMealId &&
      (sourceMealQuery.isLoading || candidatesQuery.isLoading));

  const handlePick = (meal: MealSummary) => {
    onPickReplacement(meal);
    onClose();
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
            <Text style={s.title}>Find similar</Text>
            {sourceCuisine && (
              <Text style={s.subtitle}>Cuisine: {sourceCuisine}</Text>
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
          <View style={s.sectionTitleRow}>
            <Text style={s.sectionTitle}>Similar meals</Text>
            <SortDropdown value={sortKey} onChange={setSortKey} />
          </View>

          {isLoading ? (
            <View style={s.loadingCard}>
              <LoadingShim variant="inline" />
            </View>
          ) : hadError ? (
            <View style={s.errorBanner}>
              <Feather
                name="alert-circle"
                size={14}
                color={KColors.terracotta[700]}
              />
              <Text style={s.errorBannerText}>
                Couldn&apos;t reach Kiwi — try again.
              </Text>
            </View>
          ) : matches.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No similar meals found.</Text>
              <Text style={s.emptyBody}>
                Try Change Meal to browse all your options.
              </Text>
            </View>
          ) : (
            <View style={s.list}>
              {matches.map((meal) => (
                <MealRow
                  key={meal.id}
                  meal={meal}
                  onPress={() => handlePick(meal)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function MealRow({
  meal,
  onPress,
}: {
  meal: MealSummary;
  onPress: () => void;
}) {
  const metaParts = [
    meal.cuisineType,
    capitalize(meal.difficulty),
    `${meal.estimatedTimeMinutes} min`,
  ].filter(Boolean);
  const macrosLine = `${meal.caloriesPerServing} cal · ${meal.proteinGPerServing}g P · ${meal.carbsGPerServing}g C · ${meal.fatGPerServing}g F`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.mealRow, pressed && { opacity: 0.7 }]}
    >
      <View style={[s.thumb, !meal.imageUrl && s.thumbFallback]} />
      <View style={{ flex: 1 }}>
        <Text style={s.mealTitle} numberOfLines={1} ellipsizeMode="tail">
          {meal.title}
        </Text>
        <Text style={s.mealMeta} numberOfLines={1} ellipsizeMode="tail">
          {metaParts.join(" · ")}
        </Text>
        <Text style={s.mealMacros} numberOfLines={1} ellipsizeMode="tail">
          {macrosLine}
        </Text>
      </View>
      {meal.timesCooked !== undefined && meal.timesCooked > 0 && (
        <Text style={s.useCount}>Cooked {meal.timesCooked}×</Text>
      )}
    </Pressable>
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
    gap: KSpacing.sm,
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
  },
  title: {
    fontSize: KType.size.xl,
    fontWeight: KType.weight.bold,
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.sm,
    paddingVertical: KSpacing.xs,
    paddingHorizontal: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  errorBannerText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  loadingCard: {
    marginTop: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
    padding: KSpacing.lg,
  },
  loadingText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  emptyCard: {
    marginTop: KSpacing.sm,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    gap: KSpacing.xs,
  },
  emptyTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  emptyBody: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  mealTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  mealMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  mealMacros: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  useCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
});
