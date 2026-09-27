// /test-kitchen — Row 13 "Test Kitchen" · Block 2. THE DOOR IN.
//
// R1 — WEB ONLY. On native this redirects to "/" before any hook runs, so
// nothing a store reviewer can reach changes. The platform check lives in the
// default export and the real screen is a child component: that way the guest
// hooks are never conditionally called (🔴 HOOKS SIT ABOVE THE EARLY RETURNS —
// there is no react-hooks ESLint plugin in this package, only a device catches
// it).
//
// R2 — resume an unexpired stored guest session, else create one, then open the
// wizard in guest mode. The resume/create decision is
// lib/guest/guestSession.ts's deriveGuestEntryAction (tested); where a resumed
// visitor belongs is deriveGuestStage.
//
// R12 — the Turnstile widget renders only when EXPO_PUBLIC_TURNSTILE_SITE_KEY is
// set. It is unset in this block, so the entry starts the session immediately;
// with a key set, the start waits for a token.

import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { TurnstileGate } from "@/components/TurnstileGate";
import { WizardScreen } from "@/components/WizardScreen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useGuest } from "@/contexts/GuestContext";
import { getGuestSession } from "@/lib/api/guest";
import { ApiError, UnauthenticatedError } from "@/lib/api/errors";
import { deriveGuestStage, guestGenerationSpent } from "@/lib/guest/guestSession";
import { turnstileEnabled } from "@/lib/guest/turnstile";

// ── Copy ─────────────────────────────────────────────────────────────────
export const TK_TITLE = "Kiwi Test Kitchen";
export const TK_SUBTITLE = "Build a week of dinners — no account needed";
export const TK_STARTING = "Setting up your Test Kitchen…";
export const TK_START_LABEL = "Start cooking";
export const TK_CAP_TITLE = "That's a few sessions from here already";
export const TK_CAP_BODY =
  "The Test Kitchen has a daily limit per visitor. Create a free account and build as many plans as you like.";
export const TK_DOWN_TITLE = "The Test Kitchen is closed right now";
export const TK_DOWN_BODY = "Try again in a moment, or create a free account and start in the app.";
export const TK_FAILED_TITLE = "Kiwi got distracted. Try again?";
export const TK_RESUME_PLAN = "Pick up where you left off — see your plan";
export const TK_RESUME_OPTIONS = "Pick up where you left off — see your plans";

export default function TestKitchenRoute() {
  // R1. A constant on any given build, but kept as the FIRST thing in the
  // component so no guest hook is ever mounted on native.
  if (Platform.OS !== "web") return <Redirect href="/" />;
  return <TestKitchenEntry />;
}

function TestKitchenEntry() {
  const router = useRouter();
  const { session, status, error, startOrResume, endGuestSession } = useGuest();
  const [turnstileToken, setTurnstileToken] = React.useState<string | null>(null);
  const gated = turnstileEnabled();
  const started = React.useRef(false);

  // Start once. `startOrResume` is idempotent (it shares the in-flight promise),
  // but the ref keeps a re-render from re-entering it at all — a guest's one
  // generation is too expensive to protect only downstream.
  //
  // ⚠️ `session` is in the deps, and it is not decoration: the recovery effect
  // below clears a server-dead session and lowers the ref, and without `session`
  // here nothing would change to make this re-run — the visitor would sit on the
  // "starting" loader forever. With the ref still guarding, the added dep only
  // ever re-fires the mint after a deliberate teardown.
  React.useEffect(() => {
    if (started.current) return;
    if (gated && !turnstileToken) return;
    started.current = true;
    void startOrResume(turnstileToken ? { turnstileToken } : {}).catch(() => {
      // Rendered from `error` below; a rejected start must not be an unhandled
      // rejection in a browser console.
      started.current = false;
    });
  }, [gated, turnstileToken, startOrResume, session]);

  // Where a resumed visitor belongs. Guest-OK (GET /guest/session); skipped
  // until a session exists so it never fires tokenless.
  const sessionQuery = useQuery({
    queryKey: ["guest", "session", session?.guestSessionId ?? null],
    queryFn: getGuestSession,
    enabled: !!session,
    staleTime: 0,
  });

  // A stored token the SERVER has finished with: expired past its 24 h row, or
  // claimed by a sign-up in another tab. The client-side expiry check
  // (deriveGuestEntryAction) cannot see either, so the read's 401 is the only
  // signal — and it is NOT the session-expired cascade for a guest, by design, so
  // nothing else would react to it. Clear and mint a fresh session rather than
  // leaving the visitor on a form whose generate is guaranteed to 401.
  React.useEffect(() => {
    if (!(sessionQuery.error instanceof UnauthenticatedError)) return;
    endGuestSession();
    started.current = false;
  }, [sessionQuery.error, endGuestSession]);

  const stage = sessionQuery.data
    ? deriveGuestStage({
        generationCount: sessionQuery.data.generationCount,
        hasDraft: sessionQuery.data.hasDraft,
        candidates: sessionQuery.data.candidates,
      })
    : null;
  const spent = sessionQuery.data ? guestGenerationSpent(sessionQuery.data) : false;

  // ── the pre-session states ───────────────────────────────────────────
  if (status === "failed") {
    const apiStatus = error instanceof ApiError ? error.status : null;
    const capped = apiStatus === 429;
    const down = apiStatus === 503;
    return (
      <View style={s.screen}>
        <Header title={TK_TITLE} subtitle={TK_SUBTITLE} />
        <View style={s.body}>
          <View style={s.card}>
            <Text style={s.cardTitle}>
              {capped ? TK_CAP_TITLE : down ? TK_DOWN_TITLE : TK_FAILED_TITLE}
            </Text>
            <Text style={s.cardBody}>
              {capped ? TK_CAP_BODY : down ? TK_DOWN_BODY : (error?.message ?? TK_DOWN_BODY)}
            </Text>
            <Button
              label="Create my free account"
              variant="primary"
              onPress={() => router.push("/(auth)/sign-up")}
            />
            {!capped && (
              <Button
                label="Try again"
                variant="ghost"
                onPress={() => {
                  started.current = false;
                  void startOrResume(turnstileToken ? { turnstileToken } : {}).catch(() => {});
                }}
              />
            )}
          </View>
        </View>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={s.screen}>
        <Header title={TK_TITLE} subtitle={TK_SUBTITLE} />
        <View style={s.body}>
          <View style={s.card}>
            <Text style={s.cardTitle}>{TK_TITLE}</Text>
            <Text style={s.cardBody}>{TK_SUBTITLE}</Text>
            {gated ? (
              <>
                <TurnstileGate onToken={setTurnstileToken} />
                <Button
                  label={TK_START_LABEL}
                  variant="primary"
                  disabled={!turnstileToken || status === "starting"}
                  onPress={() => {
                    started.current = false;
                    void startOrResume({ turnstileToken: turnstileToken! }).catch(() => {});
                  }}
                />
              </>
            ) : (
              <LoadingShim variant="inline" label={TK_STARTING} />
            )}
          </View>
        </View>
      </View>
    );
  }

  // ── live ─────────────────────────────────────────────────────────────
  // R2's letter: the entry OPENS THE WIZARD. A visitor who already generated is
  // not sent back to a form they cannot submit — the banner above it carries
  // them forward, and the wizard's own CTA is a door once the generation is
  // spent (the server's 409 is the authority; `spent` is what lets the client
  // show the door instead of spending a call to be refused).
  const resumeHref =
    stage === "plan" ? "/test-kitchen/plan" : stage === "options" ? "/test-kitchen/options" : null;

  return (
    <WizardScreen
      mode="prefs"
      guest
      guestGenerationSpent={spent}
      guestResumeBanner={
        resumeHref ? (
          <Pressable
            onPress={() => router.push(resumeHref)}
            style={({ pressed }) => [s.resume, pressed && { opacity: 0.7 }]}
          >
            <Text style={s.resumeText}>
              {stage === "plan" ? TK_RESUME_PLAN : TK_RESUME_OPTIONS}
            </Text>
          </Pressable>
        ) : null
      }
    />
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.neutral[100] },
  body: { padding: Spacing[4] },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    gap: Spacing[3],
  },
  cardTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  resume: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  resumeText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
});
