// /test-kitchen — Row 13 "Test Kitchen" · Block 2. THE DOOR IN.
//
// R1 — was WEB ONLY, and is not since Resub C1: Apple rejected 1.0 under
// 5.1.1(v) because nothing could be used without an account, so Welcome's
// "Explore without an account" opens this screen on iOS and Android too. The
// platform redirect that used to sit in the default export is gone; the real
// screen stays a child component (🔴 HOOKS SIT ABOVE THE EARLY RETURNS — there
// is no react-hooks ESLint plugin in this package, only a device catches it).
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
import { useRouter } from "expo-router";
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
import { decideTurnstileEntry, decideTurnstileRetry } from "@/lib/guest/turnstilePrewarm";

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
/** Resub C2 — in the app, the reader is already in it. */
export const TK_DOWN_BODY_NATIVE =
  "Try again in a moment, or create a free account and start planning right here.";
export function tkDownBody(platform: string): string {
  return platform === "web" ? TK_DOWN_BODY : TK_DOWN_BODY_NATIVE;
}
export const TK_FAILED_TITLE = "Kiwi got distracted. Try again?";
export const TK_RESUME_PLAN = "Pick up where you left off — see your plan";
export const TK_RESUME_OPTIONS = "Pick up where you left off — see your plans";

export default function TestKitchenRoute() {
  return <TestKitchenEntry />;
}

function TestKitchenEntry() {
  const router = useRouter();
  const { session, status, error, startOrResume, endGuestSession, turnstile, dispatchTurnstile } =
    useGuest();
  const gated = turnstileEnabled();
  // Resub C3 (BUG-361) — the token Welcome pre-warmed, read ONCE, at the tap.
  // Fresh and ready → it is sent at once and no gate is drawn. Anything else
  // (still warming, interactive, failed, stale, web) → the visible gate below,
  // exactly as before; when Cloudflare wants a checkbox, that is where it shows.
  // Resub C4 (BUG-368) — settable: a retry may take a pre-warmed token that
  // arrived since, or drop the one it held so the visible gate shows.
  const [prewarmedToken, setPrewarmedToken] = React.useState<string | null>(() =>
    gated && decideTurnstileEntry(turnstile, Date.now()) === "use_token" ? turnstile.token : null,
  );
  const [turnstileToken, setTurnstileToken] = React.useState<string | null>(prewarmedToken);
  const started = React.useRef(false);
  // Resub C4 (BUG-368) — every token this entry has put on a create. A token
  // validates once, so none of these is ever sent again.
  const sentTokens = React.useRef<Set<string>>(new Set());
  // Bumped on a regate: a new key mounts a fresh widget, which solves a fresh
  // token (the solved one would never call onToken again).
  const [gateKey, setGateKey] = React.useState(0);

  // The one place a create is started, so the sent-token ledger and the
  // pre-warmed token's single use cannot be skipped by any path.
  const sendStart = React.useCallback(
    (token: string | null, fromWarm: boolean) => {
      started.current = true;
      if (token !== null) sentTokens.current.add(token);
      const call = startOrResume(token ? { turnstileToken: token } : {});
      // BUG-361 — a token is single use: once the pre-warmed one has gone out in
      // a create, it leaves the store whether the create succeeded or failed. A
      // RESUME never sends it, so it stays for the next visitor who needs it.
      if (fromWarm) {
        call.then(
          (action) => {
            if (action !== "resume") dispatchTurnstile({ type: "consume" });
          },
          () => dispatchTurnstile({ type: "consume" }),
        );
      }
      void call.catch(() => {
        // Rendered from `error` below; a rejected start must not be an
        // unhandled rejection in a browser console.
        started.current = false;
      });
    },
    [startOrResume, dispatchTurnstile],
  );

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
    // BUG-368 — the effect re-fires on `session`; a token already sent once is
    // never the one it starts with (the retry below regates instead).
    if (turnstileToken !== null && sentTokens.current.has(turnstileToken)) return;
    sendStart(turnstileToken, prewarmedToken !== null && turnstileToken === prewarmedToken);
  }, [gated, turnstileToken, session, prewarmedToken, sendStart]);

  // Resub C4 (BUG-368) — both retry paths ("Try again" on the failure card and
  // "Start cooking" under the gate). lib/guest/turnstilePrewarm.ts
  // decideTurnstileRetry decides; this only carries it out.
  const retryStart = () => {
    const d = decideTurnstileRetry({
      gated,
      tokenInHand: turnstileToken,
      sentTokens: sentTokens.current,
      warm: turnstile,
      now: Date.now(),
    });
    started.current = false;
    if (d.action === "start") {
      if (d.fromWarm && d.token !== null) {
        setPrewarmedToken(d.token);
        setTurnstileToken(d.token);
      }
      sendStart(d.token, d.fromWarm);
      return;
    }
    // Regate: discard the spent token(s) and draw a fresh widget.
    if (turnstile.token !== null && sentTokens.current.has(turnstile.token)) {
      dispatchTurnstile({ type: "discard" });
    }
    setTurnstileToken(null);
    setPrewarmedToken(null);
    setGateKey((k) => k + 1);
    // Off the failure card and back to the gate. The failed create left no
    // usable session behind (a create only runs when there is none), so this
    // clears nothing the visitor has.
    if (status === "failed") endGuestSession();
  };

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
              {capped ? TK_CAP_BODY : down ? tkDownBody(Platform.OS) : (error?.message ?? tkDownBody(Platform.OS))}
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
                onPress={retryStart}
                testID="tk-try-again"
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
            {/* BUG-361 — with a pre-warmed token the start is already in
                flight: no gate, just the loader. */}
            {gated && prewarmedToken === null ? (
              <>
                <TurnstileGate key={gateKey} onToken={setTurnstileToken} />
                <Button
                  label={TK_START_LABEL}
                  variant="primary"
                  disabled={!turnstileToken || status === "starting"}
                  onPress={retryStart}
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
      guestHasDraft={sessionQuery.data?.hasDraft ?? false}
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
