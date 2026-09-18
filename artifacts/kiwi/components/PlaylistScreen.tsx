// WS9 Redesign Arc Block 2b Part A (D-WS9-234 / D-WS9-244) — the Playlist tab.
//
// Where users manage the meals they cook the most — DECLARED intent, never
// derived from cook counts. Copy is "your go-to favorites" (never "the meals you
// actually cook"). No "last cooked" anywhere (no data source at launch,
// BUG-275). Fed by GET /me/playlist (the shared MealCard shape + addedAt).
//
// Rows (Block 2c Part D, Hans item 23 — "mirror the 'my meals' listview
// convention"): the shared MealRowBody (thumb · serif title · two-line
// description · meta "{total} min · {active} min hands-on · {difficulty}"
// (derived times AS SENT, D-WS9-235) · a macros line when the card carries
// non-zero macros · cuisine + tag pills de-duped, BUG-284) · an "in this
// week's plan" chip · a "⋯" menu (View meal · Remove from playlist). The
// WHOLE row taps through to Meal Detail; the menu stays for Remove.
//
// The "in this week's plan" chip is the SERVER's per-row `inActivePlan`
// (post-pass server Part C, BUG-283; wired here in D-WS9-191 Block 2 Part C) —
// deterministic, no cache dependency. The earlier client derivation (the plan
// DETAIL query with enabled:false, cache-only) is gone.
//
// Footer: "Add meals" (primary → today's Create Meal screen with toPlaylist=1)
// and "Plan a week from these" (ghost → the Pick screen in playlist mode;
// disabled at 0). Empty state: the intro + a card + the same "Add meals".
//
// Mounted by app/(tabs)/playlist.tsx. 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { MealRowBody } from "@/components/MealRowBody";
import { PlanCardOverflowMenu } from "@/components/PlanCardOverflowMenu";
import { PlaylistImportReviewSheet } from "@/components/PlaylistImportReviewSheet";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { formatMacroLine } from "@/lib/format/macros";
import { cardPills } from "@/lib/meals/cardPills";
import {
  beginImportReview,
  clearImportReview,
  endImportReview,
  useImportReview,
} from "@/lib/builder/playlistImportReview";
import {
  getPlaylist,
  PLAYLIST_QUERY_KEY,
  removeFromPlaylist,
  type GetPlaylistResponse,
  type PlaylistMeal,
} from "@/lib/api/playlist";

// Copy — verbatim from the rulings; the empty-state body is proposed.
export const PLAYLIST_TITLE = "Playlist";
export const PLAYLIST_SUBLINE = (n: number) => `your go-to favorites · ${n}`;
export const PLAYLIST_INTRO =
  "Your go-to favorites live here. Kiwi rotates them through your plans so nothing wears out.";
export const IN_PLAN_CHIP = "in this week's plan";
export const ADD_MEALS_LABEL = "Add meals";
export const PLAN_WEEK_LABEL = "Plan a week from these";
export const EMPTY_TITLE = "No playlist yet.";
export const EMPTY_BODY =
  "Add the meals you already cook and Kiwi will rotate them through your plans.";
export const MENU_VIEW = "View meal";
export const MENU_REMOVE = "Remove from playlist";

export function playlistMetaLine(m: PlaylistMeal): string {
  const active = m.activeTimeMinutes === null ? "—" : String(m.activeTimeMinutes);
  // Block 2c Part D — cuisine moved to the pills (the My-Meals convention);
  // the line is times + difficulty.
  const parts = [
    `${m.estimatedTimeMinutes} min`,
    `${active} min hands-on`,
    m.difficulty,
  ].filter((p): p is string => !!p && p.length > 0);
  return parts.join(" · ");
}

/** Cuisine + tags as pills, de-duped (BUG-284); the difficulty is on the meta line. */
export function playlistPills(m: Pick<PlaylistMeal, "cuisineType" | "difficulty" | "tags">): string[] {
  const diff = (m.difficulty ?? "").toLowerCase();
  return cardPills(m).filter((t) => t.toLowerCase() !== diff);
}

/**
 * The macros line — only when the card carries them and they are not all
 * zero (a fresh import saves zeros; "0 cal · 0g P" is noise, not data).
 * Tolerates the field being absent so the row is green if a server shape
 * ever ships without it.
 */
export function playlistMacroLine(m: Partial<Pick<PlaylistMeal, "macrosPerServing">>): string | null {
  const x = m.macrosPerServing;
  if (!x) return null;
  if (!(x.calories > 0 || x.protein > 0 || x.carbs > 0 || x.fat > 0)) return null;
  return formatMacroLine(x.calories, x.protein, x.carbs, x.fat);
}

export function PlaylistScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const playlistQuery = useQuery({
    queryKey: PLAYLIST_QUERY_KEY,
    queryFn: getPlaylist,
  });

  // The "in this week's plan" chip reads the SERVER's per-row `inActivePlan`
  // (post-pass server Part C, BUG-283) — the cache-only client derivation is
  // gone (D-WS9-191 Block 2 Part C).

  // Block 2c Part A — the bulk intake's review sheet. Staged by the builder
  // when a run finishes; hidden while a "Review ›" editor is open above this
  // tab (a native Modal would sit over it) and shown again on focus.
  const review = useImportReview();
  useFocusEffect(
    React.useCallback(() => {
      endImportReview();
    }, []),
  );
  const handleReviewMeal = (mealId: string) => {
    beginImportReview(mealId);
    router.push({
      pathname: "/meal-builder",
      params: { mealId, reviewReturn: "playlist" },
    });
  };

  // Remove — optimistic: the row drops at once, the DELETE is idempotent, a
  // failure restores the cached list (undo not required by the ruling).
  const removeMutation = useMutation<void, Error, string, { prev?: GetPlaylistResponse }>({
    mutationFn: removeFromPlaylist,
    onMutate: async (mealId) => {
      await queryClient.cancelQueries({ queryKey: PLAYLIST_QUERY_KEY });
      const prev = queryClient.getQueryData<GetPlaylistResponse>(PLAYLIST_QUERY_KEY);
      if (prev) {
        const playlist = prev.playlist.filter((m) => m.id !== mealId);
        queryClient.setQueryData<GetPlaylistResponse>(PLAYLIST_QUERY_KEY, {
          playlist,
          count: playlist.length,
        });
      }
      return { prev };
    },
    onError: (_err, _mealId, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(PLAYLIST_QUERY_KEY, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PLAYLIST_QUERY_KEY });
    },
  });

  const meals = playlistQuery.data?.playlist ?? [];
  const count = playlistQuery.data?.count ?? meals.length;

  const handleAddMeals = () =>
    router.push({ pathname: "/meal-builder", params: { toPlaylist: "1" } });
  const handlePlanWeek = () =>
    router.push({ pathname: "/pick-meals", params: { source: "playlist" } });
  const handleView = (mealId: string) =>
    router.push({ pathname: "/meal/[id]", params: { id: mealId } });

  if (playlistQuery.isLoading) {
    return (
      <View style={s.bg}>
        <Header title={PLAYLIST_TITLE} />
        <View style={s.loadingWrap}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.bg}>
      <Header title={PLAYLIST_TITLE} subtitle={PLAYLIST_SUBLINE(count)} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.intro}>{PLAYLIST_INTRO}</Text>

        {playlistQuery.isError && (
          <View style={s.noticeCard}>
            <Text style={s.noticeTitle}>Couldn&apos;t load your playlist.</Text>
            <Text style={s.noticeBody}>Pull back and try again.</Text>
          </View>
        )}

        {!playlistQuery.isError && meals.length === 0 && (
          <View style={s.emptyCard}>
            <Text style={s.emptyTitle}>{EMPTY_TITLE}</Text>
            <Text style={s.emptyBody}>{EMPTY_BODY}</Text>
            <View style={{ marginTop: Spacing[3] }}>
              <Button label={ADD_MEALS_LABEL} variant="primary" onPress={handleAddMeals} />
            </View>
          </View>
        )}

        {meals.length > 0 && (
          <View style={s.list}>
            {meals.map((m) => (
              <PlaylistRow
                key={m.id}
                meal={m}
                inActivePlan={m.inActivePlan ?? false}
                onView={() => handleView(m.id)}
                onRemove={() => removeMutation.mutate(m.id)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <PlaylistImportReviewSheet
        visible={review.items.length > 0 && review.reviewingId === null}
        items={review.items}
        onReview={handleReviewMeal}
        onDone={clearImportReview}
      />

      {/* Sticky footer. */}
      <View style={[s.footer, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <View style={{ flex: 1 }}>
          <Button
            label={ADD_MEALS_LABEL}
            variant="primary"
            onPress={handleAddMeals}
            testID="playlist-add"
          />
        </View>
        <View style={{ flex: 1.4 }}>
          <Button
            label={PLAN_WEEK_LABEL}
            variant="ghost"
            onPress={handlePlanWeek}
            disabled={meals.length === 0}
            testID="playlist-plan"
          />
        </View>
      </View>
    </View>
  );
}

// D-WS9-191 Block 2 Part C — the row's thumb is the server's imageUrl through
// TreatedImage (the photo when there is one, the warm placeholder ramp
// otherwise). WS9 row 5 Block 2 — MealRowBody now renders that slot itself
// for every host (ImageTreatment.thumb.row), so the row passes `image` and
// the local thumbSlot / size are gone.

function PlaylistRow({
  meal,
  inActivePlan,
  onView,
  onRemove,
}: {
  meal: PlaylistMeal;
  inActivePlan: boolean;
  onView: () => void;
  onRemove: () => void;
}) {
  const macros = playlistMacroLine(meal);
  return (
    <View style={s.row}>
      {/* The whole card taps through to Meal Detail (Hans item 23); the menu
          keeps View meal beside Remove — a one-item menu reads broken. */}
      <Pressable
        onPress={onView}
        accessibilityRole="button"
        accessibilityLabel={meal.title}
        style={({ pressed }) => [s.cardArea, pressed && { opacity: 0.85 }]}
      >
        <MealRowBody
          title={meal}
          description={meal.description}
          meta={playlistMetaLine(meal)}
          tags={playlistPills(meal)}
          image={meal.imageUrl}
        >
          {macros ? (
            <Text style={s.macros} numberOfLines={1}>
              {macros}
            </Text>
          ) : null}
          {inActivePlan && (
            <View style={s.chip}>
              <Text style={s.chipText}>{IN_PLAN_CHIP}</Text>
            </View>
          )}
        </MealRowBody>
      </Pressable>
      <PlanCardOverflowMenu
        accessibilityLabel={`More for ${meal.title}`}
        items={[
          { label: MENU_VIEW, icon: "eye", onPress: onView },
          { label: MENU_REMOVE, icon: "minus-circle", onPress: onRemove, destructive: true },
        ]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[6],
    gap: Spacing[3],
  },
  intro: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  list: { gap: 9 },
  // MealRow's surface, verbatim (the My-Meals convention).
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    padding: Spacing[2],
    borderWidth: 1,
    borderColor: Colors.neutral[200],
  },
  cardArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  macros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  chip: {
    alignSelf: "flex-start",
    marginTop: 2,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[100],
  },
  chipText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  emptyCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[4],
  },
  emptyTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  emptyBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
    marginTop: 4,
  },
  noticeCard: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[3],
  },
  noticeTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  noticeBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  footer: {
    flexDirection: "row",
    gap: Spacing[2],
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
  },
});
