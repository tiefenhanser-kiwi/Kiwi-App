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
import { DisplayTitle } from "@/components/DisplayTitle";
import { FilterChipRow } from "@/components/FilterChipRow";
import { ImportSourceCards } from "@/components/ImportSourceCards";
import { LoadingShim } from "@/components/LoadingShim";
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
import {
  dedupeMealsByTitle,
  normalizeMealTitleKey,
  preferMoreCompleteMeal,
} from "@/lib/meals/dedupeByTitle";
import { MEAL_DISABLED_SORT_KEYS, toMealSortKey } from "@/lib/meals/sortMapping";
import { mealListItemToSummary } from "@/lib/plans/mealListItemToSummary";
import type { MealSummary } from "@/lib/types";

// WS9 3d Part 4 (D-WS9-018) — ChangeMealSheet + FindSimilarSheet merged into ONE
// swap sheet with two modes, driven off the Plan Review meal row's two swap
// actions.
//   - "different": the filter-chip browser over the catalog buckets. WS9 3f-4 —
//     keyset-paginated via useInfiniteMeals (load-on-scroll); free (no AI call).
//   - "similar":   the useFindSimilarMeals AI RANKING pipeline. WS9 3f-4 — the
//     pool is de-duplicated by dish identity and bounded (BUG-058 client half);
//     NO infinite scroll here ON PURPOSE (each page is an AI call, cost guard).
//   - BOTH modes:  the "Bring in something new" import chooser + inline Ask-Kiwi
//     creator (Thread A).
//
// WS9 3f-4b (device-testing polish): the import chooser moved from a buried
// bottom bar to a collapsible expander directly under the header (§5.2); the
// filter chips + sort are pinned above the scrolling list (§5.3); the list
// scrolls under a shadowed edge (§5.4); meal titles wrap to two lines (§5.1);
// Similar mode shows a static "Best match" indicator instead of a sort control
// that would let the user discard the ranking (§5.6). The transparent Modal is
// navigationBar-translucent so it covers the Android nav bar on edge-to-edge
// devices (BUG-056: otherwise the sheet stops above the nav bar and the plan
// screen shows through the strip). Source exclusion is by id AND normalized
// title so a same-title duplicate record of the source can't appear (BUG-061).

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
  /** Display name for the sheet header (Similar mode) AND — WS9 3f-4b (BUG-061) —
   *  the source's title, used to exclude same-title duplicate records of the
   *  source from the candidate lists (id alone misses distinct-id duplicates). */
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

// Similar-mode: all four catalog buckets unioned in one request. (featured +
// hosting resolve empty server-side today — D-WS7-039 — so the live union is
// my_meals ∪ top_rated; the empty buckets are harmless and stay for later.)
const FIND_SIMILAR_BUCKETS: readonly MealFilterKey[] = [
  "my_meals",
  "featured",
  "top_rated",
  "hosting",
];

// WS9 3f-4 (Thread E) — bounded raise of the candidate pool (server clamps to
// [1,100]); the public-catalog contribution stays server-capped (3f-5's fix).
const SIMILAR_CANDIDATE_LIMIT = 60;
// Hard ceiling on the model payload — never send more than this many candidates
// INTO find-similar, regardless of library size (input bound / cost guard).
const FIND_SIMILAR_MAX_PAYLOAD = 60;
// WS9 3f-4 follow-on — how many ranked matches actually RENDER (the "close but
// not quite" near-miss set). 20 is the outer bound if a later ruling raises it.
const FIND_SIMILAR_RENDER_LIMIT = 8;
// How many to ASK the model for: the render target plus headroom, because
// de-duplication runs AFTER ranking and can shrink the returned set.
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

// WS9 3f-4b (BUG-061) — exclude the source from its own replacement list by id
// AND normalized title. The library holds distinct-id records that share a
// title, so an id-only filter let a duplicate of the source survive.
function excludesSource(
  candidateId: string,
  candidateTitle: string,
  sourceMealId: string,
  sourceTitleKey: string | null,
): boolean {
  if (candidateId === sourceMealId) return true;
  if (sourceTitleKey && normalizeMealTitleKey(candidateTitle) === sourceTitleKey) {
    return true;
  }
  return false;
}

export function SwapMealSheet({
  visible,
  mode,
  sourceMealId,
  sourceMealTitle,
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
  // (§8.4.2), NOT append. Close the sheet first, then push past the slide-out.
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
      // WS9 3f-4b (BUG-056) — cover the Android system bars on edge-to-edge
      // devices (Expo SDK 54 forces edge-to-edge). Without navigationBarTranslucent
      // the transparent Modal stops above the gesture nav bar, so the backdrop +
      // sheet don't reach the true bottom and the Plan Review screen shows through
      // the strip. iOS ignores both flags (full-screen already).
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      {/* Full-screen flex container pins the sheet flush to the true screen
          bottom (justify flex-end). */}
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
            // free of a native dep; the shared AskKiwiView owns the keyboard-Done
            // affordance (§6.1).
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
              {/* WS9 3f-4b (§5.2) — import chooser at the TOP, collapsible,
                  expands downward over the list. Was a buried bottom bar. */}
              <ImportExpander
                context={importContext}
                onClose={onClose}
                onAskKiwi={() => setAskOpen(true)}
              />

              {displayMode === "similar" ? (
                <SimilarBody
                  visible={visible}
                  sourceMealId={sourceMealId}
                  sourceMealTitle={sourceMealTitle}
                  onPick={handlePick}
                />
              ) : (
                <DifferentBody
                  sourceMealId={sourceMealId}
                  sourceMealTitle={sourceMealTitle}
                  onPick={handlePick}
                />
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Import expander (§5.2) — collapsible, top-anchored ────────────────────────

function ImportExpander({
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
    <View style={s.importExpander}>
      <Pressable
        style={({ pressed }) => [s.importToggle, pressed && s.importTogglePressed]}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <Feather name="plus-circle" size={20} color={Colors.sage[700]} />
        <Text style={s.importToggleText}>Bring in something new</Text>
        <Feather
          name="chevron-down"
          size={20}
          color={Colors.sage[700]}
          style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {expanded ? (
        <ScrollView
          style={s.importScroll}
          contentContainerStyle={s.importScrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
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
  sourceMealTitle,
  onPick,
}: {
  visible: boolean;
  sourceMealId: string;
  sourceMealTitle?: string;
  onPick: (meal: MealSummary) => void;
}) {
  const [aiOrderedIds, setAiOrderedIds] = useState<string[] | null>(null);
  const [hadError, setHadError] = useState(false);

  const findSimilarMutation = useFindSimilarMeals();
  const candidatesQuery = useMeals(FIND_SIMILAR_BUCKETS, SIMILAR_CANDIDATE_LIMIT);
  const sourceMealQuery = useMeal(sourceMealId);
  const sourceMeal = sourceMealQuery.data;

  const sourceTitleKey = sourceMealTitle
    ? normalizeMealTitleKey(sourceMealTitle)
    : null;

  // WS9 3f-4 (Thread E) — de-duplicate the raw candidate rows by dish identity
  // (normalized title) BEFORE ranking, excluding the source by id AND title
  // (BUG-061). §6.2 — the survivor per title is the most COMPLETE record
  // (deterministic), so a half-built duplicate isn't the one swapped in.
  const dedupedItems = useMemo(() => {
    if (!sourceMealId || !candidatesQuery.data) return [];
    const items = candidatesQuery.data.meals.filter(
      (m) => !excludesSource(m.id, m.title, sourceMealId, sourceTitleKey),
    );
    return dedupeMealsByTitle(items, preferMoreCompleteMeal);
  }, [candidatesQuery.data, sourceMealId, sourceTitleKey]);

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
    // Hard-cap the payload regardless of library size.
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
    // Intentionally only re-fire on the visible/source/data-arrival transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sourceMealId, sourceMeal, candidatesQuery.data]);

  const matches = useMemo<MealSummary[]>(() => {
    if (!sourceMealId || !aiOrderedIds) return [];
    const byId = new Map(candidatePool.map((m) => [m.id, m]));
    const ordered = aiOrderedIds
      .map((id) => byId.get(id))
      .filter((m): m is MealSummary => !!m);
    // Defensive second dedupe (id-repeat → same title), then cap at the render
    // target: the top N distinct matches BY RANK. No sort control in this mode
    // (§5.6) — the AI ranking is the whole value; we never reorder it.
    return dedupeMealsByTitle(ordered).slice(0, FIND_SIMILAR_RENDER_LIMIT);
  }, [sourceMealId, aiOrderedIds, candidatePool]);

  const isLoading =
    findSimilarMutation.isPending ||
    (visible &&
      !!sourceMealId &&
      (sourceMealQuery.isLoading || candidatesQuery.isLoading));

  const showError =
    hadError ||
    (visible &&
      !!sourceMealId &&
      (sourceMealQuery.isError || candidatesQuery.isError));

  return (
    <>
      {/* §5.3 sticky header — kept out of the scroll. §5.5: the "Similar meals"
          label does real work (no chips here). §5.6: a static "Best match"
          indicator replaces the sort control. */}
      <View style={s.stickyControls}>
        <View style={s.sectionTitleRow}>
          <Text style={s.sectionTitle}>Similar meals</Text>
          <View style={s.bestMatchPill}>
            <Feather name="zap" size={12} color={Colors.sage[700]} />
            <Text style={s.bestMatchText}>Best match</Text>
          </View>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
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
    </>
  );
}

// ── Different mode: the filter-chip browser (keyset-paginated) ─────────────────

function DifferentBody({
  sourceMealId,
  sourceMealTitle,
  onPick,
}: {
  sourceMealId: string;
  sourceMealTitle?: string;
  onPick: (meal: MealSummary) => void;
}) {
  // Default to My Meals — the most useful chip when swapping a known meal.
  const [activeFilter, setActiveFilter] = useState<MealFilterKey>("my_meals");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  // WS9 3f-4 — keyset-paginated + server-sorted, load-on-scroll. No AI call, so
  // infinite scroll is free.
  const mealsQuery = useInfiniteMeals([activeFilter], toMealSortKey(sortKey));

  const sourceTitleKey = sourceMealTitle
    ? normalizeMealTitleKey(sourceMealTitle)
    : null;

  // Current-meal exclusion by id AND normalized title (BUG-061), symmetric with
  // Similar mode. Not deduped otherwise — this is the raw library browser.
  const visibleMeals = useMemo(() => {
    return mealsQuery.meals
      .filter((m) => !excludesSource(m.id, m.title, sourceMealId, sourceTitleKey))
      .map((m) => mealListItemToSummary(m, activeFilter));
  }, [mealsQuery.meals, activeFilter, sourceMealId, sourceTitleKey]);

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
    <>
      {/* §5.3 sticky: chips + sort pinned above the list. §5.5: the redundant
          "My Meals" heading (it restated the selected chip) is removed. */}
      <View style={s.stickyControls}>
        <FilterChipRow<MealFilterKey>
          options={FILTER_OPTIONS}
          selected={[activeFilter]}
          onToggle={(key) => setActiveFilter(key)}
        />
        <View style={s.sortRow}>
          {/* WS9-2 BUG-075 — grey the cook-stat keys with no backing meal field. */}
          <SortDropdown
            value={sortKey}
            onChange={setSortKey}
            disabledKeys={MEAL_DISABLED_SORT_KEYS}
          />
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={32}
      >
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
        {/* §5.1 — titles wrap to TWO lines before truncating, so rows that share
            a long prefix ("Air Fryer Crispy Chicken Tenders with…") stay
            distinguishable. Rows grow; density decisions wait for real images. */}
        <DisplayTitle source={meal} variant="row" style={s.mealTitle} />
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
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[6],
  },
  // §5.2 — the top import expander. WS9 3f-4c (§6) — medium-green fill + larger
  // text so it reads as a clear secondary affordance (terracotta is the primary
  // CTA colour, so green doesn't compete as a CTA). Still one compact row, so
  // the candidate list stays the dominant element.
  importExpander: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.sage[400],
    backgroundColor: Colors.sage[200],
  },
  importToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingVertical: Spacing[3],
    paddingHorizontal: Spacing[4],
  },
  importTogglePressed: {
    backgroundColor: Colors.sage[300],
  },
  importToggleText: {
    flex: 1,
    fontSize: Typography.fontSize.md,
    color: Colors.sage[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  importScroll: {
    maxHeight: 280,
  },
  importScrollContent: {
    paddingHorizontal: Spacing[4],
    paddingBottom: Spacing[3],
  },
  // §5.3 sticky chips/sort/label — pinned above the list. §5.4 — a subtle bottom
  // shadow so scrolled content reads as passing UNDER it, not sliced by an edge.
  stickyControls: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[2],
    backgroundColor: Colors.neutral[100],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[200],
    zIndex: 1,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  sortRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: Spacing[2],
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
  bestMatchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  bestMatchText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
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
