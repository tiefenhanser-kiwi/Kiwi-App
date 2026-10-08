// WS9 Redesign Arc Block 2a Part D (D-WS9-237) — "Pick your meals": the picks
// ARE the plan.
//
// Fed by the wizard's POST /wizard/shelf response (Part C, path A). The user
// taps cards to pick, "Get more options" pages the shelf by exclusion, and
// "Build my week" posts the picked ids (in the order picked) to
// POST /plans/from-meals, which creates ONE ACTIVE plan — no chooser, no draft,
// no AI — and lands on the plan screen the wizard's activate lands on today
// (/plan/[id]), invalidating ["plans"] + ["home"] (the BUG-051 gap) and showing
// the existing demotion toast when a previous this-week plan was displaced.
//
// The rules (rounds 4 / thin-shelf 2, exhausted, over-cap counted-not-blocked)
// live in lib/wizard/pickMeals.ts where they are tested; this file is the
// chrome and the wiring. Mounted by app/pick-meals.tsx (route name chosen to
// match the kebab-case sibling routes: wizard-results, meal-builder).
//
// Resub C4 — the Test Kitchen's "Meals to choose from" mounts THIS screen with
// `guest` (app/test-kitchen/pick.tsx): a set of gates on the existing screen,
// not a second screen, the WizardScreen pattern. Under `guest`:
//   · "Get more options" pages the shelf through the guest wrapper;
//   · "Build my week" posts POST /guest/plan-from-picks (the session's ONE plan,
//     composed from the catalog, zero AI) and lands on /test-kitchen/plan —
//     never POST /plans/from-meals, never ["plans"] / ["home"], never
//     /plan/[id]: a guest owns no plan rows;
//   · its two 409s are doors: a spent session → the sign-up sheet, a pick the
//     catalog cannot compose → the thin-shelf card;
//   · the exhausted card's two exits (/wizard, /tellkiwi — member routes, the
//     second the AI-invention surface) become the thin-shelf sign-up exit.
// The card itself writes nothing (its only control is the local pick toggle),
// and this screen reads nothing member-only: no /me/*, no last-batch, no
// playlist (PlaylistPickScreen below does, and a guest never reaches it).
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { ExhaustedCard } from "@/components/ExhaustedCard";
import { GuestDoorSheet } from "@/components/GuestDoorSheet";
import { Header } from "@/components/Header";
import { MealPickCard } from "@/components/MealPickCard";
import { useGuestOptional } from "@/contexts/GuestContext";
import { useToast } from "@/contexts/ToastProvider";
import { useGuestDoor } from "@/hooks/useGuestDoor";
import {
  buildGuestPlanFromPicks,
  buildGuestShelf,
  GUEST_MAX_PICKS,
  trackGuestEvent,
  type GuestPicksResult,
} from "@/lib/api/guest";
import { todayLocalDate } from "@/lib/dates";
import { THIN_SHELF_CTA, thinShelfTitle } from "@/lib/guest/doors";
import { buildGuestWizardPayload, type GuestWizardForm } from "@/lib/wizard/guestPayload";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  createPlanFromMeals,
  getPlan,
  type CreatePlanFromMealsResponse,
} from "@/lib/api/plans";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import { buildWizardShelf, type WizardShelfResponse } from "@/lib/api/wizard";
import { demotionToastMessage } from "@/lib/plans/planLifecycleActions";
import {
  buildShelfRequest,
  wizardFormFromPreferences,
  type WizardShelfRequest,
} from "@/lib/wizard/perRunPayload";
import {
  appendPage,
  excludeIdsFor,
  footerPickedLine,
  initialPickState,
  isExhausted,
  MORE_PAGE_SIZE,
  moreCaption,
  overCapPickedCount,
  pickHeaderSubline,
  showNewToYouChips,
  SLOW_ROUND_MS,
  togglePick,
  type PickMealsParamsInput,
  type PickState,
} from "@/lib/wizard/pickMeals";

// Copy — verbatim from the locked mockups.
export const PICK_TITLE = "Pick your meals";
// Block 2b — the Playlist tab's "Plan a week from these": the same screen in
// playlist mode (source:"playlist" shelf — only the user's playlist meals, no
// Kiwi suggestions, no "Get more options", no exhausted card).
export const PLAYLIST_PICK_TITLE = "Pick from your playlist";
export const PLAYLIST_PICK_SUBLINE = (n: number) =>
  `${n} in your playlist · per serving · tap to add`;
export const MORE_LABEL = "Get more options";
export const MORE_SLOW_CAPTION = "Kiwi is creating a few new ones…";
// D-WS9-191 Block 2 — the exhausted card is a shared component now
// (components/ExhaustedCard.tsx: the copy, the two dismissTo exits); its copy
// is re-exported here unchanged for the importers that read it from this file.
export {
  EXHAUSTED_BODY,
  EXHAUSTED_REFINE,
  EXHAUSTED_TELL,
  EXHAUSTED_TITLE,
} from "@/components/ExhaustedCard";
export const BUILD_LABEL = "Build my week";
export const FOOTER_FLEX = (days: number) => `fewer or more than ${days} is fine`;
export const FOOTER_OVER_CAP = (n: number, cap: number) => ` · ${n} over your ${cap}-min cap`;
export const COULDNT_FIND = (names: string[]) => `Couldn't find: ${names.join(", ")}`;
// D-WS9-191 Block 2 Part C — the SERVER names a picks plan (lib/planTitle.ts:
// "{Name}'s meals, week of {Mon D}"); the client sends NO title. The from-meals
// 201 carries no name, so the demotion toast reads it off the plan detail
// (the same query Plan Review mounts next — warmed, not doubled) and falls
// back to this when that read fails.
export const PICKS_PLAN_FALLBACK_NAME = "Your new plan";
// Resub C4 — the guest's lines. The plan-from-picks cap is 7 (G1: one meal per
// candidate slot), where the member's from-meals takes 14.
export const GUEST_PICKS_OVER = (n: number) =>
  `The Test Kitchen plan holds up to ${GUEST_MAX_PICKS} meals — unpick ${n}`;
export const GUEST_PICKS_GAP_BODY = (titles: string[]) =>
  titles.length > 0
    ? `Kiwi couldn't put together ${titles.join(", ")} in the Test Kitchen.`
    : "";

export type PickMealsScreenProps = PickMealsParamsInput & {
  /** Block 2b — "Plan a week from these". Playlist-only: no paging, no exhausted card. */
  source?: "playlist";
  /** Resub C4 — the Test Kitchen. See the header. */
  guest?: boolean;
  /** The guest's wizard answers — plan-from-picks' `preferences`. Required with `guest`. */
  guestForm?: GuestWizardForm;
};

export function PickMealsScreen({
  shelf,
  request,
  mode,
  planDurationDays,
  householdSize,
  capMinutes,
  source,
  guest = false,
  guestForm,
}: PickMealsScreenProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  // Resub C4 — mounted unconditionally (hooks above everything). For a member
  // the door never opens and the context is simply unread.
  const guestCtx = useGuestOptional();
  const guestDoor = useGuestDoor();
  // The refusal of a pick the catalog cannot compose — the thin-shelf card.
  const [guestGap, setGuestGap] = useState<string[] | null>(null);

  const [state, setState] = useState<PickState>(() => initialPickState(shelf));

  // "Get more options" — the shelf again with every shown id excluded. A guest
  // pages the same route under the guest principal (the request carries no
  // text and no source: it is buildGuestShelfRequest's body).
  const moreMutation = useMutation<WizardShelfResponse, Error, WizardShelfRequest>({
    mutationFn: guest ? buildGuestShelf : buildWizardShelf,
  });
  // The 3 s caption: while a round is in flight longer than SLOW_ROUND_MS the
  // caption says Kiwi is creating new ones (the AI fallback lands server-side
  // later; the client is ready for it).
  const [slowRound, setSlowRound] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (moreMutation.isPending) {
      slowTimer.current = setTimeout(() => setSlowRound(true), SLOW_ROUND_MS);
    } else {
      setSlowRound(false);
    }
    return () => {
      if (slowTimer.current) {
        clearTimeout(slowTimer.current);
        slowTimer.current = null;
      }
    };
  }, [moreMutation.isPending]);

  const buildMutation = useMutation<CreatePlanFromMealsResponse, Error, string[]>({
    mutationFn: (mealIds) =>
      createPlanFromMeals({
        mealIds,
        planDurationDays,
        householdSize,
      }),
  });

  // Resub C4 — the guest's "Build my week". Never createPlanFromMeals.
  const guestBuildMutation = useMutation<GuestPicksResult, Error, string[]>({
    mutationFn: (mealIds) =>
      buildGuestPlanFromPicks({
        mealIds,
        // The guest's whole wizard body, as build-plans gets it (G1b).
        preferences: buildGuestWizardPayload(guestForm!),
        localDate: todayLocalDate(),
      }),
  });

  const handleGuestBuild = () => {
    if (state.pickedIds.length === 0 || guestBuildMutation.isPending) return;
    if (state.pickedIds.length > GUEST_MAX_PICKS) return;
    setGuestGap(null);
    guestBuildMutation.mutate(state.pickedIds, {
      onSuccess: (result) => {
        if (result.status === "generation_used") {
          // One plan per session, whichever path — a second is the door.
          guestDoor.open("second_generation");
          return;
        }
        if (result.status === "catalog_only_gap") {
          void trackGuestEvent("thin_shelf", {
            meta: { liveSlotTitles: result.liveSlotTitles },
          });
          setGuestGap(result.liveSlotTitles);
          return;
        }
        // The plan screen reads GET /guest/draft — seed it with the very
        // envelope that route returns, and let the session read learn that the
        // one plan is spent and a draft exists (the entry's resume + the
        // wizard's spent notice both key on it).
        // BUG-366 — the draft carries no image; the picked cards do.
        const picked = new Set(state.pickedIds);
        guestCtx?.setPickedMealImages(
          Object.fromEntries(
            state.meals
              .filter((m) => picked.has(m.id) && m.imageUrl)
              .map((m) => [m.id, m.imageUrl as string]),
          ),
        );
        const sessionId = guestCtx?.session?.guestSessionId ?? null;
        queryClient.setQueryData(["guest", "draft", sessionId], result.draft);
        queryClient.invalidateQueries({ queryKey: ["guest", "session"] });
        router.replace("/test-kitchen/plan");
      },
    });
  };

  const handleMore = () => {
    if (moreMutation.isPending || isExhausted(state)) return;
    moreMutation.mutate(
      { ...request, excludeMealIds: excludeIdsFor(state), size: MORE_PAGE_SIZE },
      {
        onSuccess: (page) => setState((prev) => appendPage(prev, page)),
      },
    );
  };

  const handleBuild = () => {
    if (state.pickedIds.length === 0 || buildMutation.isPending) return;
    buildMutation.mutate(state.pickedIds, {
      onSuccess: async (result) => {
        // BUG-051's gap — the same invalidation the activate path does.
        queryClient.invalidateQueries({ queryKey: ["plans"] });
        queryClient.invalidateQueries({ queryKey: ["home"] });
        // D-WS9-011a — the existing demotion toast, off the response's `demoted`,
        // naming the plan as the SERVER named it (Part C).
        if (result.demoted) {
          let name = PICKS_PLAN_FALLBACK_NAME;
          try {
            const id = result.instance.id;
            const plan = await queryClient.fetchQuery({
              queryKey: ["plans", "detail", id],
              queryFn: () => getPlan(id),
            });
            name = plan.name || name;
          } catch {
            // the toast still shows, with the fallback name
          }
          const msg = demotionToastMessage(name, result.demoted);
          if (msg) showToast({ message: msg });
        }
        router.replace({
          pathname: "/plan/[id]",
          params: { id: result.instance.id },
        });
      },
    });
  };

  // The exhausted card's two exits (BACK to the wizard on the stack via
  // dismissTo — Block 2b ruling, no stack growth) live on the shared
  // ExhaustedCard since D-WS9-191 Block 2.

  const isPlaylist = source === "playlist";
  const exhausted = isExhausted(state);
  const overCapPicked = overCapPickedCount(state, capMinutes);
  const pickedCount = state.pickedIds.length;
  // Block 2c Part C — over the cards on screen NOW, so a round can flip it.
  // For a guest every row is isNewToYou (G1), so this is false and the pill is
  // suppressed — the rule's own "a NEW user sees it on nearly every card" case.
  const newToYouChips = showNewToYouChips(state.meals);
  const guestOverBy = guest ? Math.max(0, pickedCount - GUEST_MAX_PICKS) : 0;
  const building = guest ? guestBuildMutation.isPending : buildMutation.isPending;
  const buildError = guest ? guestBuildMutation.error : buildMutation.error;
  // The thin-shelf card, for a guest: the exits the member card offers are
  // member routes (and Tell Kiwi is the AI-invention surface), so the one exit
  // is sign-up — the options screen's guest variant, word for word.
  const guestThinShelfCard = (body: string) => (
    <ExhaustedCard
      title={thinShelfTitle(Platform.OS)}
      body={body}
      guestExit={{ label: THIN_SHELF_CTA, onPress: () => guestDoor.open("thin_shelf") }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header
        showBack
        title={isPlaylist ? PLAYLIST_PICK_TITLE : PICK_TITLE}
        subtitle={
          isPlaylist
            ? PLAYLIST_PICK_SUBLINE(state.totalEligible)
            : pickHeaderSubline(state.totalEligible)
        }
      />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {mode === "text" && state.unmatchedNames.length > 0 && (
          <Text style={s.quietLine}>{COULDNT_FIND(state.unmatchedNames)}</Text>
        )}

        <View style={s.list}>
          {state.meals.map((meal) => (
            <MealPickCard
              key={meal.id}
              meal={meal}
              selected={state.pickedIds.includes(meal.id)}
              capMinutes={capMinutes}
              showNewToYou={newToYouChips}
              onToggle={() => setState((prev) => togglePick(prev, meal.id))}
            />
          ))}
        </View>

        {moreMutation.isError && (
          <View style={s.noticeCard}>
            <Text style={s.noticeTitle}>Kiwi got distracted. Try again?</Text>
            {moreMutation.error?.message ? (
              <Text style={s.noticeBody}>{moreMutation.error.message}</Text>
            ) : null}
          </View>
        )}

        {/* Playlist mode: the list IS the whole shelf — no paging, no
            exhausted card (an empty playlist never reaches this screen; the
            tab's button is disabled at 0). */}
        {isPlaylist ? null : exhausted ? (
          guest ? (
            guestThinShelfCard("")
          ) : (
            <ExhaustedCard />
          )
        ) : (
          <View style={s.moreWrap}>
            <Pressable
              onPress={handleMore}
              disabled={moreMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={MORE_LABEL}
              style={({ pressed }) => [s.moreButton, pressed && { opacity: 0.7 }]}
            >
              {moreMutation.isPending ? (
                <ActivityIndicator color={Colors.sage[700]} />
              ) : (
                <Text style={s.moreLabel}>{MORE_LABEL}</Text>
              )}
            </Pressable>
            <Text style={s.moreCaption}>
              {moreMutation.isPending && slowRound
                ? MORE_SLOW_CAPTION
                : moreCaption(state.roundsLeft)}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Sticky footer. */}
      <View style={[s.footer, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <Text style={s.footerLine1}>{footerPickedLine(pickedCount, planDurationDays)}</Text>
        <Text style={s.footerLine2}>
          {FOOTER_FLEX(planDurationDays)}
          {overCapPicked > 0 && capMinutes !== null && (
            <Text style={s.footerOverCap}>{FOOTER_OVER_CAP(overCapPicked, capMinutes)}</Text>
          )}
        </Text>
        {guestOverBy > 0 && (
          <Text style={s.footerError} testID="pick-guest-over">
            {GUEST_PICKS_OVER(guestOverBy)}
          </Text>
        )}
        {/* Resub C4 — a pick the catalog could not compose: the thin-shelf
            card, HERE, beside the button that was tapped (BUG-316's lesson). */}
        {guestGap && guestThinShelfCard(GUEST_PICKS_GAP_BODY(guestGap))}
        {buildError && (
          <Text style={s.footerError} testID="pick-build-error">
            {buildError.message || "Couldn't build your week. Try again."}
          </Text>
        )}
        <Button
          label={BUILD_LABEL}
          variant="primary"
          onPress={guest ? handleGuestBuild : handleBuild}
          disabled={pickedCount === 0 || guestOverBy > 0}
          loading={building}
          testID="pick-build"
        />
      </View>
      {/* Resub C4 — the shared door. Renders nothing until a guest action hits
          it; for a member no action ever does. */}
      <GuestDoorSheet action={guestDoor.door} onClose={guestDoor.close} />
    </View>
  );
}

const s = StyleSheet.create({
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  statusBox: {
    margin: Spacing[4],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[6],
    gap: Spacing[3],
  },
  quietLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  list: {
    gap: 9,
  },
  moreWrap: {
    gap: Spacing[1],
    alignItems: "center",
  },
  // A ghost, full-width, in line with the cards.
  moreButton: {
    alignSelf: "stretch",
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[600],
    backgroundColor: "transparent",
    paddingHorizontal: Spacing[4],
  },
  moreLabel: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  moreCaption: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
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
    lineHeight: 20,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    gap: Spacing[2],
  },
  footerLine1: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  footerLine2: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: -4,
  },
  footerOverCap: {
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  footerError: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
});


// ── Block 2b — "Plan a week from these": load the playlist shelf, then pick ──
// The Playlist tab routes here with ONLY `source=playlist` — no shelf in the
// params. This fetches the user's stored preferences (the body the server
// schema requires: plan length, household, difficulty, pacing…), posts the
// shelf with source:"playlist", and mounts the Pick screen in playlist mode.
// No wizard screen in between: the stored preferences ARE the run.

export function PlaylistPickScreen() {
  const router = useRouter();
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
  });
  const request = React.useMemo(
    () =>
      prefsQuery.data
        ? buildShelfRequest(wizardFormFromPreferences(prefsQuery.data), true, {
            source: "playlist",
          })
        : null,
    [prefsQuery.data],
  );
  const shelfQuery = useQuery<WizardShelfResponse>({
    queryKey: ["wizard", "shelf", "playlist", request],
    queryFn: () => buildWizardShelf(request!),
    enabled: request !== null,
    // Hot-volatile: a playlist edit must show on the next open.
    staleTime: 0,
  });

  if (prefsQuery.isError || shelfQuery.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title={PLAYLIST_PICK_TITLE} />
        <View style={s.statusBox}>
          <Text style={s.noticeTitle}>Kiwi got distracted. Try again?</Text>
          <Text style={s.noticeBody}>
            {(shelfQuery.error ?? prefsQuery.error)?.message ||
              "Couldn't load your playlist. Please try again."}
          </Text>
          <View style={{ marginTop: Spacing[3] }}>
            <Button label="Back" variant="primary" onPress={() => router.back()} />
          </View>
        </View>
      </View>
    );
  }
  if (!request || !shelfQuery.data) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title={PLAYLIST_PICK_TITLE} />
        <View style={s.loadingWrap}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      </View>
    );
  }
  return (
    <PickMealsScreen
      shelf={shelfQuery.data}
      request={request}
      mode="prefs"
      planDurationDays={request.planDurationDays}
      householdSize={request.householdSize}
      capMinutes={request.maxCookTimeMinutes ?? null}
      source="playlist"
    />
  );
}
