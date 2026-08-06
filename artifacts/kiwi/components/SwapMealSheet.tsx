import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AskKiwiCreator } from "@/components/AskKiwiCreator";
import { FilterChipRow } from "@/components/FilterChipRow";
import { ImportSourceCards } from "@/components/ImportSourceCards";
import { LoadingShim } from "@/components/LoadingShim";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useFindSimilarMeals } from "@/hooks/useFindSimilarMeals";
import { useMeal } from "@/hooks/useMeal";
import { useInfiniteMeals, useMeals } from "@/hooks/useMeals";
import {
  importEntryParams,
  type ImportEntryContext,
} from "@/lib/builder/importEntryParams";
import type { MealCandidatePayload, MealDetail, MealFilterKey } from "@/lib/api/meals";
import { formatMacroLine } from "@/lib/format/macros";
import { dedupeMealsByTitle } from "@/lib/meals/dedupeByTitle";
import { toMealSortKey } from "@/lib/meals/sortMapping";
import { mealListItemToSummary } from "@/lib/plans/mealListItemToSummary";
import type { MealSummary } from "@/lib/types";

// WS9 3d Part 4 (D-WS9-018) — ChangeMealSheet + FindSimilarSheet merged into ONE
// swap sheet with two modes, driven off the Plan Review meal row's two swap
// actions.
//   - "different": the filter-chip browser over the catalog buckets (was
//     ChangeMealSheet). WS9 3f-4 (Thread B) — now keyset-paginated via
//     useInfiniteMeals (load-on-scroll); free because it makes no AI call.
//   - "similar":   the useFindSimilarMeals AI RANKING pipeline (was
//     FindSimilarSheet) — it ranks existing rows, never generates. WS9 3f-4
//     (Thread E) — the pool is de-duplicated by dish identity and bounded, the
//     client half of BUG-058. NO infinite scroll here ON PURPOSE (each page is
//     an AI call — cost guard, §4.2).
//   - BOTH modes:  the "Bring in something new" import chooser, now in a PINNED
//     bottom bar (Thread B) instead of buried under the scrolling list, and the
//     Ask-Kiwi creator mounted INLINE (Thread A) instead of routing away.
// Layout carried from FindSimilarSheet's gap-free shell (flex justify:flex-end +
// maxHeight:90%); the per-body ScrollViews scroll behind the pinned import bar.

export type SwapMode = "different" | "similar";

export interface SwapMealSheetProps {
  visible: boolean;
  /** Which swap the meal row invoked. */
  mode: SwapMode;
  /** The meal being replaced — excluded from results in BOTH modes. */
  sourceMealId: string;
  /** WS9 3f-3 (D-WS9-005) — the plan + slot being replaced. When BOTH are
   *  present, the "Bring in something new" chooser AND the inline Ask-Kiwi
   *  creator thread them so an imported/created replacement REPLACES this slot
   *  (§8.4.2) instead of abandoning the swap. Optional: when absent the flows
   *  degrade to a bare library create. */
  planId?: string;
  planItemId?: string;
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
// dedupes by id and React Query caches under the multi-key array. (featured +
// hosting resolve empty server-side today — D-WS7-039 — so the live union is
// my_meals ∪ top_rated; the empty buckets are harmless and stay for when
// curation flags land.)
const FIND_SIMILAR_BUCKETS: readonly MealFilterKey[] = [
  "my_meals",
  "featured",
  "top_rated",
  "hosting",
];

// WS9 3f-4 (Thread E, §5.2) — bounded raise of the candidate pool. The pre-3f-4
// call used the default 20-row page; requesting 60 lets more of the user's own
// meals through (the server clamps to [1,100], so this is a pure client change —
// the public-catalog contribution stays capped server-side, 3f-5's fix).
const SIMILAR_CANDIDATE_LIMIT = 60;
// Hard ceiling on the model payload — never send more than this many candidates
// INTO find-similar, regardless of library size. Bounded cost per call, forever.
// (Input bound / cost guard — distinct from the render count below.)
const FIND_SIMILAR_MAX_PAYLOAD = 60;
// WS9 3f-4 follow-on — how many ranked matches actually RENDER (the "close but
// not quite" near-miss set; 8 is enough to surface it without a browsing
// session). 20 is the outer bound if a later ruling raises it — not built toward.
const FIND_SIMILAR_RENDER_LIMIT = 8;
// How many to ASK the model for: the render target plus headroom, because
// de-duplication runs AFTER ranking and can shrink the returned set. The pool is
// already title-deduped before sending, so the only post-rank shrink is the
// model repeating an id (same title); the headroom absorbs that so a full 8
// still render. We never pad with lower-ranked filler — if dedup leaves fewer
// than 8, fewer render.
const FIND_SIMILAR_MODEL_LIMIT = FIND_SIMILAR_RENDER_LIMIT + 4;

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
  planId,
  planItemId,
  onClose,
  onPickReplacement,
}: SwapMealSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // WS9 3f-3 (D-WS9-005) — the swap is a REPLACE, so the chooser + Ask-Kiwi
  // creator thread planId + planItemId. Degrade to a bare library create only
  // if the host didn't supply them.
  const importContext: ImportEntryContext =
    planId && planItemId
      ? { kind: "replace", planId, planItemId }
      : { kind: "library" };

  // Freeze the rendered mode while the sheet is closing so the slide-out
  // animation doesn't flash the other mode's body. Only updated while open.
  const [displayMode, setDisplayMode] = useState<SwapMode>(mode);
  // WS9 3f-4 (Thread A) — the inline Ask-Kiwi creator. Fresh opens (and mode
  // switches) always start in the browse view.
  const [askOpen, setAskOpen] = useState(false);
  useEffect(() => {
    if (visible) {
      setDisplayMode(mode);
      setAskOpen(false);
    }
  }, [visible, mode]);

  const handlePick = (meal: MealSummary) => {
    onPickReplacement(meal);
    onClose();
  };

  // WS9 3f-4 (Thread A) — a successful in-sheet creation completes the swap by
  // threading the REPLACE params (importEntryParams) into the meal-builder push;
  // the builder's save then resolves plan-replace → changeMealForPlanItem
  // (§8.4.2), NOT append. Close the sheet first, then push past the slide-out
  // (mirrors ImportSourceCards.navigateAfterClose).
  const handleAskNavigateToDraft = (draftJson: string) => {
    onClose();
    setTimeout(() => {
      router.push({
        pathname: "/meal-builder",
        params: {
          draftSource: "text",
          draftJson,
          ...importEntryParams(importContext),
        },
      });
    }, 150);
  };
  const handleAskUpgrade = () => {
    onClose();
    setTimeout(() => router.push("/upgrade"), 150);
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
            {askOpen ? (
              <Pressable onPress={() => setAskOpen(false)} hitSlop={12}>
                <Feather name="chevron-left" size={22} color={Colors.neutral[800]} />
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={s.title}>
                {askOpen
                  ? "Ask Kiwi for a meal"
                  : displayMode === "similar"
                    ? "Find similar"
                    : "Change meal"}
              </Text>
              {askOpen ? (
                <Text style={s.subtitle}>
                  Describe a meal and Kiwi drafts it into this slot
                </Text>
              ) : displayMode === "similar" ? (
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

          {askOpen ? (
            // WS9 3f-4 (Thread A) — the inline creator (one-shot: free text → one
            // parsed meal → meal-builder draft that completes the swap). A plain
            // ScrollView (not the keyboard-controller wrapper) keeps this sheet
            // free of a native dep; the sheet is bottom-anchored so the input
            // sits well above the keyboard.
            <ScrollView
              style={s.scroll}
              contentContainerStyle={s.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <AskKiwiCreator
                navigateToDraft={handleAskNavigateToDraft}
                routeToUpgrade={handleAskUpgrade}
              />
            </ScrollView>
          ) : (
            <>
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

              {/* WS9 3f-4 (Thread B) — the import chooser, now PINNED at the
                  bottom (was last inside the scroll, buried under the list) and
                  reachable in BOTH modes. Collapsed + subordinate by default so
                  candidates stay primary; the Ask-Kiwi card mounts the creator
                  inline (onAskKiwi) instead of routing away. */}
              <ImportBar
                context={importContext}
                onClose={onClose}
                onAskKiwi={() => setAskOpen(true)}
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Pinned import bar (Thread B) ──────────────────────────────────────────────

function ImportBar({
  context,
  onClose,
  onAskKiwi,
}: {
  context: ImportEntryContext;
  onClose: () => void;
  onAskKiwi: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={s.importBar}>
      <Pressable
        style={({ pressed }) => [s.importToggle, pressed && { opacity: 0.7 }]}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <Feather name="plus-circle" size={16} color={Colors.sage[700]} />
        <Text style={s.importToggleText}>Bring in something new</Text>
        <Feather
          name={expanded ? "chevron-down" : "chevron-up"}
          size={18}
          color={Colors.neutral[600]}
        />
      </Pressable>
      {expanded ? (
        <ScrollView
          style={s.importScroll}
          contentContainerStyle={s.importScrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <ImportSourceCards
            context={context}
            includeAskKiwi
            onAskKiwi={onAskKiwi}
            hideSectionTitle
            onClose={onClose}
          />
        </ScrollView>
      ) : null}
    </View>
  );
}

// ── Similar mode: the AI ranking pipeline ─────────────────────────────────────

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
  const candidatesQuery = useMeals(FIND_SIMILAR_BUCKETS, SIMILAR_CANDIDATE_LIMIT);
  const sourceMealQuery = useMeal(sourceMealId);
  const sourceMeal = sourceMealQuery.data;

  // WS9 3f-4 (Thread E, §5.1) — de-duplicate the raw candidate rows by dish
  // identity (normalized title) BEFORE ranking. The user's own library holds
  // distinct records for the same dish (measured: many "Beef Tacos" rows,
  // different ids, dishFamilyKey null) — an id-key would miss them. Deduping the
  // pool means the model's result slots each land on a distinct dish, and it
  // cannot return three ids for the same title.
  const dedupedItems = useMemo(() => {
    if (!sourceMealId || !candidatesQuery.data) return [];
    const items = candidatesQuery.data.meals.filter((m) => m.id !== sourceMealId);
    return dedupeMealsByTitle(items);
  }, [candidatesQuery.data, sourceMealId]);

  const candidatePool = useMemo<MealSummary[]>(
    () => dedupedItems.map((m) => mealListItemToSummary(m, "my_meals")),
    [dedupedItems],
  );

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
    // §5.2 — hard-cap the payload regardless of library size.
    const payload = dedupedItems.slice(0, FIND_SIMILAR_MAX_PAYLOAD);
    findSimilarMutation.mutate(
      {
        source: mealDetailToCandidate(sourceMeal),
        candidates: payload.map((m) => ({
          id: m.id,
          title: m.title,
          cuisine: m.cuisine.length > 0 ? m.cuisine : null,
          mealType: CANDIDATE_MEAL_TYPE,
          tags: m.tags,
        })),
        limit: FIND_SIMILAR_MODEL_LIMIT,
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
    // Defensive second layer (§5.1): if the model repeats an id, both copies map
    // to the same title — dedupe keeps the highest-ranked and drops the rest,
    // never reordering the survivors. THEN cap the rendered list at the target:
    // the top N distinct matches by rank (no lower-ranked filler — a short list
    // of good matches is the intent). Slice before the view-sort so the user's
    // re-sort reorders the top-N-by-similarity, not a longer set.
    const capped = dedupeMealsByTitle(ordered).slice(0, FIND_SIMILAR_RENDER_LIMIT);
    return sortKey === "alpha" ? capped : sortMeals(capped, sortKey);
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
    </ScrollView>
  );
}

// ── Different mode: the filter-chip browser (keyset-paginated) ─────────────────

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

  // WS9 3f-4 (Thread B, §4.2) — keyset-paginated + server-sorted, load-on-scroll.
  // Server sort (toMealSortKey) keeps pages globally ordered, so there is no
  // client re-sort of a partial page. No AI call here, so infinite scroll is free.
  const mealsQuery = useInfiniteMeals([activeFilter], toMealSortKey(sortKey));

  // Ruling 10 — current-meal exclusion applies symmetrically across all buckets.
  const visibleMeals = useMemo(() => {
    const adapted = mealsQuery.meals.map((m) =>
      mealListItemToSummary(m, activeFilter),
    );
    return sourceMealId
      ? adapted.filter((meal) => meal.id !== sourceMealId)
      : adapted;
  }, [mealsQuery.meals, activeFilter, sourceMealId]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - contentOffset.y - layoutMeasurement.height;
    if (
      distanceFromBottom < 240 &&
      mealsQuery.hasNextPage &&
      !mealsQuery.isFetchingNextPage
    ) {
      void mealsQuery.fetchNextPage();
    }
  };

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={s.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      onScroll={onScroll}
      scrollEventThrottle={32}
    >
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
      {mealsQuery.isFetchingNextPage ? (
        <View style={s.loadingRow}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      ) : null}
    </ScrollView>
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
    paddingBottom: Spacing[6],
  },
  // WS9 3f-4 (Thread B) — the pinned import bar. A visible top border is the
  // scroll boundary (content continues behind it); subordinate to the list.
  importBar: {
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    backgroundColor: Colors.neutral[50],
    paddingHorizontal: Spacing[4],
  },
  importToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingVertical: Spacing[3],
  },
  importToggleText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  importScroll: {
    maxHeight: 280,
  },
  importScrollContent: {
    paddingBottom: Spacing[3],
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
});
