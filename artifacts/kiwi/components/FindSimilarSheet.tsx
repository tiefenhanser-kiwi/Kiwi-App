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
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useFindSimilarMeals } from "@/hooks/useFindSimilarMeals";
import { useMeal } from "@/hooks/useMeal";
import { useMeals } from "@/hooks/useMeals";
import type {
  MealCandidatePayload,
  MealDetail,
  MealFilterKey,
} from "@/lib/api/meals";
import { formatMacroLine } from "@/lib/format/macros";
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

  // The error state covers BOTH failure modes uniformly: the AI ranking call
  // failing (hadError) AND either underlying read failing. Without the read
  // branch, killing the network before the source/candidate reads land would
  // skip the mutation entirely (the effect guards on data presence) and fall
  // through to the "no similar meals" empty card — an inconsistent message.
  const showError =
    hadError ||
    (visible &&
      !!sourceMealId &&
      (sourceMealQuery.isError || candidatesQuery.isError));

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
      {/* Full-screen flex container pins the sheet flush to the true screen
          bottom (justify flex-end). The earlier `position:absolute; bottom:0;
          height:85%` left a strip of the Plan Review screen showing under the
          sheet on devices where the Modal content is inset; this pattern can't
          gap because the sheet is the bottom child of a screen-filling box. */}
      <View style={s.container}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
          <View style={s.handle} />
          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Find similar</Text>
              {sourceCuisine && (
                <Text style={s.subtitle}>Cuisine: {sourceCuisine}</Text>
              )}
            </View>
            <Pressable onPress={onClose} hitSlop={12}>
              <Feather name="x" size={22} color={Colors.neutral[800]} />
            </Pressable>
          </View>

          <ScrollView
            style={s.scroll}
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
          ) : showError ? (
            <View style={s.errorBanner}>
              <Feather
                name="alert-circle"
                size={14}
                color={Colors.terracotta[700]}
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
  // Shared formatter rounds each macro to a whole number — kills the
  // "75.39999…g" float artifact that surfaces when the server stores fractional
  // per-serving macros (lib/format/macros.ts).
  const macrosLine = formatMacroLine(
    meal.caloriesPerServing,
    meal.proteinGPerServing,
    meal.carbsGPerServing,
    meal.fatGPerServing,
  );
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
  container: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Palette.background.overlay,
  },
  sheet: {
    maxHeight: "90%",
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  // flexShrink lets the scroll area give back space when the sheet hits its
  // maxHeight, so the list scrolls instead of overflowing; with a short list
  // the sheet still hugs its content.
  scroll: {
    flexShrink: 1,
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
    gap: Spacing[2],
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  subtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  scrollContent: {
    padding: Spacing[4],
    paddingBottom: Spacing[8],
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.sm,
    paddingVertical: Spacing[1],
    paddingHorizontal: Spacing[2],
    marginTop: Spacing[2],
  },
  errorBannerText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    flex: 1,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  list: {
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  loadingCard: {
    marginTop: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
    padding: Spacing[4],
  },
  loadingText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  emptyCard: {
    marginTop: Spacing[2],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
    gap: Spacing[1],
  },
  emptyTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  emptyBody: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[2],
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: Radius.sm,
    backgroundColor: Colors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: Colors.sage[100],
  },
  mealTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  mealMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  mealMacros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  useCount: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
});
