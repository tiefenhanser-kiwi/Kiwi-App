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

import { FilterChipRow } from "@/components/FilterChipRow";
import { LoadingShim } from "@/components/LoadingShim";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useFindSimilarMeals } from "@/hooks/useFindSimilarMeals";
import { useMeal } from "@/hooks/useMeal";
import { useMeals } from "@/hooks/useMeals";
import type { MealCandidatePayload, MealDetail, MealFilterKey } from "@/lib/api/meals";
import { formatMacroLine } from "@/lib/format/macros";
import { mealListItemToSummary } from "@/lib/plans/mealListItemToSummary";
import type { MealSummary } from "@/lib/types";

// WS9 3d Part 4 (D-WS9-018) — ChangeMealSheet + FindSimilarSheet merged into ONE
// swap sheet with two modes, driven off the Plan Review meal row's two swap
// actions. Lossless merge (Hans's STOP-gate ruling: merge as-is, no AI candidate
// generation for Different mode — spec §8.2's generated-pool is a logged gap, not
// this block). Every feature of both sheets survives in at least one mode:
//   - "different": the filter-chip browser over the 4 catalog buckets (was
//     ChangeMealSheet).
//   - "similar":   the useFindSimilarMeals AI RANKING pipeline over the 4 unioned
//     buckets (was FindSimilarSheet) — it ranks existing rows, never generates.
//   - BOTH modes:  the import source-quartet ("Bring in something new"), carried
//     forward UNCHANGED — including its known D-WS9-005 gap (the import path omits
//     addToPlanId/planItemId so an import abandons the swap; ruled to Block 3f,
//     which builds the shared ask-kiwi.tsx creator that owns the threading).
// Shell wins where the two conflicted:
//   - Layout: FindSimilarSheet's (flex justify:flex-end + maxHeight:90%), which
//     fixes the bottom-gap bug ChangeMealSheet's position:absolute;height:85% had.
//   - Similar-mode loading/error: FindSimilarSheet's unified model (AI call + both
//     underlying reads).
//   - Header: mode-aware (Similar keeps the source-cuisine subtitle).
// The dead premium "Ask Kiwi — coming in WS6" pill is removed, not carried; the
// real Ask-Kiwi escape hatch belongs to Block 3f (one creator, two entry points).

export type SwapMode = "different" | "similar";

export interface SwapMealSheetProps {
  visible: boolean;
  /** Which swap the meal row invoked. */
  mode: SwapMode;
  /** The meal being replaced — excluded from results in BOTH modes. In Different
   *  mode this is the old ChangeMealSheet `currentMealId`; in Similar mode the
   *  old FindSimilarSheet `sourceMealId`. Same meal either way. */
  sourceMealId: string;
  /** Display name for the sheet header (Similar mode). */
  sourceMealTitle?: string;
  /** Source cuisine for the Similar-mode header subtitle. */
  sourceCuisine?: string;
  onClose: () => void;
  /** Called when the user picks a replacement. The screen owns the optimistic
   *  update + the AppContext swap mutator (PRD §8.4.2). */
  onPickReplacement: (newMeal: MealSummary) => void;
}

// Different-mode filter buckets (single-select per FilterChipRow contract).
const FILTER_OPTIONS: { key: MealFilterKey; label: string }[] = [
  { key: "featured", label: "Featured" },
  { key: "my_meals", label: "My Meals" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting", label: "Hosting & Events" },
];

// Similar-mode: all four catalog buckets unioned in one request; the server
// dedupes by id and React Query caches under the multi-key array.
const FIND_SIMILAR_BUCKETS: readonly MealFilterKey[] = [
  "my_meals",
  "featured",
  "top_rated",
  "hosting",
];

// MealListItem (GET /me/meals) has no mealType column, so candidate payloads use
// a uniform placeholder for the required AI field (D-WS7-146 tracks widening the
// list shape). The source carries its real mealType via MealDetail.
const CANDIDATE_MEAL_TYPE = "dinner";

function mealDetailToCandidate(meal: MealDetail): MealCandidatePayload {
  return {
    id: meal.id,
    title: meal.title,
    cuisine: meal.cuisine.length > 0 ? meal.cuisine : null,
    mealType: meal.mealType,
    tags: meal.tags,
  };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function SwapMealSheet({
  visible,
  mode,
  sourceMealId,
  sourceCuisine,
  onClose,
  onPickReplacement,
}: SwapMealSheetProps) {
  const insets = useSafeAreaInsets();

  // Freeze the rendered mode while the sheet is closing so the slide-out
  // animation doesn't flash the other mode's body (the parent flips `mode` back
  // to a default the instant it clears the swap state). Only updated while open.
  const [displayMode, setDisplayMode] = useState<SwapMode>(mode);
  useEffect(() => {
    if (visible) setDisplayMode(mode);
  }, [visible, mode]);

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
          bottom (justify flex-end) — the gap-free layout carried from
          FindSimilarSheet. */}
      <View style={s.container}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
          <View style={s.handle} />
          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>
                {displayMode === "similar" ? "Find similar" : "Change meal"}
              </Text>
              {displayMode === "similar" ? (
                sourceCuisine ? (
                  <Text style={s.subtitle}>Cuisine: {sourceCuisine}</Text>
                ) : null
              ) : (
                <Text style={s.subtitle}>Browse and pick a replacement</Text>
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
            {displayMode === "similar" ? (
              <SimilarBody
                visible={visible}
                sourceMealId={sourceMealId}
                onPick={handlePick}
              />
            ) : (
              <DifferentBody
                sourceMealId={sourceMealId}
                onPick={handlePick}
              />
            )}

            {/* Bring in something new — carried unchanged into BOTH modes.
                KNOWN GAP (D-WS9-005, ruled to Block 3f): the import path pushes a
                bare route with no addToPlanId/planItemId, so importing a
                replacement abandons the swap. Fixed once in 3f's shared creator. */}
            <ImportQuartet onClose={onClose} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── Similar mode: the AI ranking pipeline (verbatim from FindSimilarSheet) ────

function SimilarBody({
  visible,
  sourceMealId,
  onPick,
}: {
  visible: boolean;
  sourceMealId: string;
  onPick: (meal: MealSummary) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("alpha");
  const [aiOrderedIds, setAiOrderedIds] = useState<string[] | null>(null);
  const [hadError, setHadError] = useState(false);

  const findSimilarMutation = useFindSimilarMeals();
  const candidatesQuery = useMeals(FIND_SIMILAR_BUCKETS);
  const sourceMealQuery = useMeal(sourceMealId);
  const sourceMeal = sourceMealQuery.data;

  const candidatePool = useMemo<MealSummary[]>(() => {
    if (!sourceMealId || !candidatesQuery.data) return [];
    return candidatesQuery.data.meals
      .map((m) => mealListItemToSummary(m, "my_meals"))
      .filter((m) => m.id !== sourceMealId);
  }, [candidatesQuery.data, sourceMealId]);

  // Fire the AI call when the sheet opens with a fresh source AND both reads have
  // landed. Reset each time so re-opening for a different meal doesn't leak.
  useEffect(() => {
    if (!visible) {
      setAiOrderedIds(null);
      setHadError(false);
      findSimilarMutation.reset();
      return;
    }
    if (!sourceMeal || !candidatesQuery.data) {
      return;
    }
    setAiOrderedIds(null);
    setHadError(false);
    findSimilarMutation.mutate(
      {
        source: mealDetailToCandidate(sourceMeal),
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
    // Intentionally only re-fire on the visible/source/data-arrival transitions —
    // candidatePool churn would loop the effect that owns the AI call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sourceMealId, sourceMeal, candidatesQuery.data]);

  const matches = useMemo<MealSummary[]>(() => {
    if (!sourceMealId || !aiOrderedIds) return [];
    const byId = new Map(candidatePool.map((m) => [m.id, m]));
    const ordered = aiOrderedIds
      .map((id) => byId.get(id))
      .filter((m): m is MealSummary => !!m);
    return sortKey === "alpha" ? ordered : sortMeals(ordered, sortKey);
  }, [sourceMealId, aiOrderedIds, sortKey, candidatePool]);

  const isLoading =
    findSimilarMutation.isPending ||
    (visible &&
      !!sourceMealId &&
      (sourceMealQuery.isLoading || candidatesQuery.isLoading));

  // Unified error state: covers the AI ranking call failing AND either underlying
  // read failing — without the read branch, killing the network before the reads
  // land would skip the mutation and fall through to the empty card.
  const showError =
    hadError ||
    (visible &&
      !!sourceMealId &&
      (sourceMealQuery.isError || candidatesQuery.isError));

  return (
    <>
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
          <Feather name="alert-circle" size={14} color={Colors.terracotta[700]} />
          <Text style={s.errorBannerText}>Couldn&apos;t reach Kiwi — try again.</Text>
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
            <MealRow key={meal.id} meal={meal} onPress={() => onPick(meal)} />
          ))}
        </View>
      )}
    </>
  );
}

// ── Different mode: the filter-chip browser (verbatim from ChangeMealSheet) ────

function DifferentBody({
  sourceMealId,
  onPick,
}: {
  sourceMealId: string;
  onPick: (meal: MealSummary) => void;
}) {
  // Default to My Meals — the most useful chip when swapping a known meal.
  const [activeFilter, setActiveFilter] = useState<MealFilterKey>("my_meals");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  const mealsQuery = useMeals([activeFilter]);

  // Ruling 10 — current-meal exclusion applies symmetrically across all 4 buckets.
  const visibleMeals = useMemo(() => {
    const adapted = (mealsQuery.data?.meals ?? []).map((m) =>
      mealListItemToSummary(m, activeFilter),
    );
    const filtered = sourceMealId
      ? adapted.filter((meal) => meal.id !== sourceMealId)
      : adapted;
    return sortMeals(filtered, sortKey);
  }, [mealsQuery.data, activeFilter, sourceMealId, sortKey]);

  return (
    <>
      <FilterChipRow<MealFilterKey>
        options={FILTER_OPTIONS}
        selected={[activeFilter]}
        onToggle={(key) => setActiveFilter(key)}
      />

      <View style={[s.sectionTitleRow, { marginTop: Spacing[2] }]}>
        <Text style={s.sectionTitle}>
          {FILTER_OPTIONS.find((o) => o.key === activeFilter)?.label}
        </Text>
        <SortDropdown value={sortKey} onChange={setSortKey} />
      </View>
      <View style={s.list}>
        {mealsQuery.isLoading ? (
          <View style={s.loadingRow}>
            <ActivityIndicator color={Colors.sage[700]} />
          </View>
        ) : mealsQuery.isError ? (
          <Pressable
            onPress={() => mealsQuery.refetch()}
            style={({ pressed }) => [s.errorRow, pressed && { opacity: 0.7 }]}
          >
            <Text style={s.errorText}>Couldn&apos;t load meals. Tap to retry.</Text>
          </Pressable>
        ) : visibleMeals.length === 0 ? (
          <Text style={s.emptyText}>No other meals here yet.</Text>
        ) : (
          visibleMeals.map((meal) => (
            <MealRow key={meal.id} meal={meal} onPress={() => onPick(meal)} />
          ))
        )}
      </View>
    </>
  );
}

// ── Shared: Bring in something new (import quartet) ───────────────────────────

function ImportQuartet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  // D-WS9-005 (ruled to 3f): bare push, no addToPlanId/planItemId — carried
  // forward unchanged from ChangeMealSheet. Deferring past the slide-out so the
  // destination doesn't mount behind a still-collapsing modal.
  const navigateAfterClose = (
    path: "/import-url" | "/import-image" | "/import-text" | "/meal-builder",
  ) => {
    onClose();
    setTimeout(() => router.push(path), 150);
  };

  return (
    <>
      <Text style={[s.sectionTitle, s.sectionGap]}>Bring in something new</Text>
      <View style={s.list}>
        <NewSourceCard
          icon="link"
          title="Import from URL"
          subtitle="Paste a recipe link"
          onPress={() => navigateAfterClose("/import-url")}
        />
        <NewSourceCard
          icon="image"
          title="Import from photo"
          subtitle="Take a photo or pick from your library"
          onPress={() => navigateAfterClose("/import-image")}
        />
        <NewSourceCard
          icon="clipboard"
          title="Import from text"
          subtitle="Paste a recipe from anywhere"
          onPress={() => navigateAfterClose("/import-text")}
        />
        <NewSourceCard
          icon="edit-3"
          title="Create manually"
          subtitle="Build a new meal from scratch"
          onPress={() => navigateAfterClose("/meal-builder")}
        />
      </View>
    </>
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

function NewSourceCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.sourceCard, pressed && { opacity: 0.85 }]}
    >
      <View style={s.sourceIcon}>
        <Feather name={icon} size={18} color={Colors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.sourceTitle}>{title}</Text>
        <Text style={s.sourceSubtitle}>{subtitle}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={Colors.neutral[600]} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  // Layout carried from FindSimilarSheet (fixes ChangeMealSheet's bottom-gap).
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
    fontFamily: Typography.face.serif[700],
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
  loadingRow: {
    alignItems: "center",
    paddingVertical: Spacing[4],
  },
  errorRow: {
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.sm,
    padding: Spacing[3],
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
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
  loadingCard: {
    marginTop: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
    padding: Spacing[4],
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
  sourceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  sourceTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sourceSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
});
