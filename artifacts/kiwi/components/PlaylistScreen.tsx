// WS9 Redesign Arc Block 2b Part A (D-WS9-234 / D-WS9-244) — the Playlist tab.
//
// Where users manage the meals they cook the most — DECLARED intent, never
// derived from cook counts. Copy is "your go-to favorites" (never "the meals you
// actually cook"). No "last cooked" anywhere (no data source at launch,
// BUG-275). Fed by GET /me/playlist (the shared MealCard shape + addedAt).
//
// Rows: thumb · title (serif) · meta "{total} min · {active} min hands-on ·
// {difficulty} · {cuisine}" (derived times AS SENT, D-WS9-235) · an "in this
// week's plan" chip · a "⋯" menu (View meal · Remove from playlist).
//
// ⚠️ THE CHIP IS CLIENT-DERIVED AND CACHE-ONLY. GET /me/playlist carries no
// in-plan flag and the Home payload carries the active plan's id but not its
// meal ids, so the chip reads the plan DETAIL query (["plans","detail",id])
// with `enabled:false` — it renders only when that query is already cached
// (the user opened the plan this session). It never fetches. CANDIDATE for the
// server: an `inActivePlan` flag on the playlist row makes it deterministic.
//
// Footer: "Add meals" (primary → today's Create Meal screen with toPlaylist=1)
// and "Plan a week from these" (ghost → the Pick screen in playlist mode;
// disabled at 0). Empty state: the intro + a card + the same "Add meals".
//
// Mounted by app/(tabs)/playlist.tsx. 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { PlanCardOverflowMenu } from "@/components/PlanCardOverflowMenu";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useHomePayload } from "@/hooks/useHomePayload";
import { getPlan, type PlanDetail } from "@/lib/api/plans";
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
  const parts = [
    `${m.estimatedTimeMinutes} min`,
    `${active} min hands-on`,
    m.difficulty,
    m.cuisineType,
  ].filter((p): p is string => !!p && p.length > 0);
  return parts.join(" · ");
}

export function PlaylistScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const playlistQuery = useQuery({
    queryKey: PLAYLIST_QUERY_KEY,
    queryFn: getPlaylist,
  });

  // The "in this week's plan" chip — cache-only, see the header note.
  const homeQuery = useHomePayload();
  const activePlanId = homeQuery.data?.activePlan?.id ?? "";
  const activePlanQuery = useQuery<PlanDetail>({
    queryKey: ["plans", "detail", activePlanId],
    queryFn: () => getPlan(activePlanId),
    enabled: false,
  });
  const activeMealIds = React.useMemo(
    () => new Set(activePlanQuery.data?.items.map((i) => i.mealId) ?? []),
    [activePlanQuery.data],
  );

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
                inActivePlan={activeMealIds.has(m.id)}
                onView={() => handleView(m.id)}
                onRemove={() => removeMutation.mutate(m.id)}
              />
            ))}
          </View>
        )}
      </ScrollView>

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
  return (
    <View style={s.row} accessibilityLabel={meal.title}>
      <TreatedImage
        source={null}
        width={THUMB}
        height={THUMB}
        radius={Radius.md}
        style={s.thumb}
      />
      <View style={s.rowBody}>
        <Text style={s.rowTitle} numberOfLines={2}>
          {meal.title}
        </Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {playlistMetaLine(meal)}
        </Text>
        {inActivePlan && (
          <View style={s.chip}>
            <Text style={s.chipText}>{IN_PLAN_CHIP}</Text>
          </View>
        )}
      </View>
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

const THUMB = 52;

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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  thumb: { backgroundColor: ImageTreatment.placeholder.base },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  rowMeta: {
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
