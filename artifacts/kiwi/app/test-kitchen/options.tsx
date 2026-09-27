// /test-kitchen/options — Row 13 · Block 2 Part D. The guest's plan options.
//
// ⚠️ A SEPARATE SCREEN FROM app/plan-options.tsx, AND THE PROMPT ASSUMED
// OTHERWISE. Part D's brief was "plan-options and plan/[id] read the guest draft
// via GET /guest/draft". They cannot, and the reason is in the code rather than
// in a preference:
//
//   · plan-options.tsx mounts the SSE stream (useBuildWizardPlansStreaming),
//     GET /wizard/limits (requireAuth) for the re-roll cap, and
//     useAnotherPlanOption; its three card actions are expand→save,
//     expand→activate and POST /wizard/candidates/dismiss. Every one of those is
//     member-only, and for a guest every one of them is a door. What would be
//     left after gating them all is this file, wrapped in `if (!guest)`.
//   · The GUEST has exactly one action per card — open it — and no cap, no
//     re-roll and no dismiss, because a second generation is a door.
//
// So the CARD is shared (components/PlanOptionCard, `guestAction`) and the
// screen is not. Reported as a deviation.
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { ExhaustedCard } from "@/components/ExhaustedCard";
import { GuestDoorSheet } from "@/components/GuestDoorSheet";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { PlanOptionCard } from "@/components/PlanOptionCard";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useGuest } from "@/contexts/GuestContext";
import { useGuestDoor } from "@/hooks/useGuestDoor";
import { expandGuestCandidate, getGuestSession, trackGuestEvent } from "@/lib/api/guest";
import { THIN_SHELF_CTA, THIN_SHELF_TITLE } from "@/lib/guest/doors";
import {
  buildGuestCandidateContext,
  guestFormFromStoredPreferences,
  type GuestWizardForm,
} from "@/lib/wizard/guestPayload";
import type { WizardPlanCandidate } from "@/lib/types";

export const GUEST_OPTIONS_TITLE = "Your plan options";
export const GUEST_OPTIONS_SUBLINE = "Open one to see the week, the meals and the recipes.";
export const GUEST_OPEN_LABEL = "See this plan";
export const GUEST_OPEN_BUSY = "Opening…";
export const GUEST_NO_OPTIONS =
  "Kiwi does not have your plan options any more. Start a fresh Test Kitchen session to build a week.";

// The form used when neither the in-tab generation nor the stored preferences
// blob can supply one. It only feeds the expand's candidateContext, and every
// field here is the same default the wizard itself starts from.
const FORM_FALLBACK: GuestWizardForm = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: [],
  eatingStyles: [],
  allergies: [],
  dietaryNotes: "",
  difficulty: "medium",
  weeklyPacing: "mostly_easy",
  additionalNotes: "",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

export default function GuestOptionsRoute() {
  if (Platform.OS !== "web") return <Redirect href="/" />;
  return <GuestOptionsScreen />;
}

function GuestOptionsScreen() {
  const router = useRouter();
  const { session, generation } = useGuest();
  const guestDoor = useGuestDoor();
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [thinShelf, setThinShelf] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // The server's copy — authoritative across a reload, and the only source of
  // the `preferences` blob the expand's context is rebuilt from.
  const sessionQuery = useQuery({
    queryKey: ["guest", "session", session?.guestSessionId ?? null],
    queryFn: getGuestSession,
    enabled: !!session,
  });

  // Prefer the in-tab generation: it is the same data, and it survives the
  // server's best-effort persist having missed (see GuestGeneration).
  const candidates: WizardPlanCandidate[] =
    generation?.candidates ?? sessionQuery.data?.candidates ?? [];
  const form: GuestWizardForm =
    generation?.form ??
    guestFormFromStoredPreferences(sessionQuery.data?.preferences, FORM_FALLBACK);

  React.useEffect(() => {
    if (candidates.length > 0) {
      void trackGuestEvent("wizard_step", { step: "options_shown" });
    }
  }, [candidates.length]);

  const openCandidate = async (candidate: WizardPlanCandidate, key: string) => {
    if (busyKey) return;
    setBusyKey(key);
    setError(null);
    setThinShelf(null);
    try {
      const result = await expandGuestCandidate({
        candidate,
        candidateContext: buildGuestCandidateContext(form),
      });
      if (result.status === "catalog_only_gap") {
        // R6 — the door, not a partial plan and not a retry.
        void trackGuestEvent("thin_shelf", {
          meta: { liveSlotTitles: result.liveSlotTitles },
        });
        setThinShelf(result.liveSlotTitles);
        return;
      }
      void trackGuestEvent("plan_opened", { meta: { title: result.draft.expanded.title } });
      router.push("/test-kitchen/plan");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kiwi got distracted. Try again?");
    } finally {
      setBusyKey(null);
    }
  };

  if (!session) {
    // The session expired or was claimed while this screen sat open. Back to the
    // door, which resumes or mints one.
    return <Redirect href="/test-kitchen" />;
  }

  return (
    <View style={s.screen}>
      <Header
        showBack
        onBack={() => router.back()}
        title={GUEST_OPTIONS_TITLE}
        subtitle={GUEST_OPTIONS_SUBLINE}
      />
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {sessionQuery.isLoading && candidates.length === 0 ? (
          <LoadingShim variant="inline" label="Fetching your plans…" />
        ) : null}

        {error ? (
          <View style={s.statusCard}>
            <Text style={s.statusTitle}>Kiwi got distracted. Try again?</Text>
            <Text style={s.statusBody}>{error}</Text>
          </View>
        ) : null}

        {/* R6 — the thin shelf. Hans's copy, verbatim, and a sign-up exit. */}
        {thinShelf ? (
          <ExhaustedCard
            title={THIN_SHELF_TITLE}
            body=""
            guestExit={{
              label: THIN_SHELF_CTA,
              onPress: () => guestDoor.open("thin_shelf"),
            }}
          />
        ) : null}

        {candidates.map((candidate, i) => {
          const key = `${i}-${candidate.title}`;
          return (
            <PlanOptionCard
              key={key}
              candidate={candidate}
              state="fresh"
              householdSize={form.householdSize}
              // Unreachable in guest mode — `guestAction` replaces the whole
              // action row — but the props are required, so they are wired to the
              // door rather than to a no-op, which would be a silent dead CTA if
              // the card's branching ever changed.
              onUseThisWeek={() => guestDoor.open("save_plan")}
              onSaveForLater={() => guestDoor.open("save_plan")}
              onNotForMe={() => guestDoor.open("edit_plan")}
              guestAction={{
                label: GUEST_OPEN_LABEL,
                busyLabel: GUEST_OPEN_BUSY,
                busy: busyKey === key,
                onPress: () => void openCandidate(candidate, key),
              }}
            />
          );
        })}

        {!sessionQuery.isLoading && candidates.length === 0 ? (
          <View style={s.statusCard}>
            <Text style={s.statusTitle}>No plan options to show</Text>
            <Text style={s.statusBody}>{GUEST_NO_OPTIONS}</Text>
            <Button
              label="Create my free account"
              variant="primary"
              onPress={() => guestDoor.open("second_generation")}
            />
          </View>
        ) : null}
      </ScrollView>
      <GuestDoorSheet action={guestDoor.door} onClose={guestDoor.close} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.neutral[100] },
  scroll: {
    padding: Spacing[4],
    paddingBottom: Spacing[8],
    gap: Spacing[3],
  },
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
