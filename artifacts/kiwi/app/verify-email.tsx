import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { KiwiMarkBadge } from "@/components/KiwiMarkBadge";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { verifyEmailChange } from "@/lib/api/me";

// WS7-2 Block D (Commit 1): the verify-side landing screen for the two-step
// email change. Reached as the deep link kiwi://verify-email?token=... — the
// request side (profile.tsx, Block C) emails this link. The JWT in `token`
// IS the auth, so the screen needs no session; verifyEmailChange() sends no
// bearer. On success we invalidate ['auth','me'] so /auth/me refetches and
// the new email lands in useAuth().user. Routing always lands on /(tabs);
// a logged-out user is then bounced to auth by index.tsx's state machine.

const INVALID_LINK_MSG = "This verification link is invalid or expired.";

// CLIENT-1 (BUG-506) — the landing the change-confirmation link opens, on the
// web and in the app: the Kiwi mark, one line, one button. No header bar (an
// emailed link has no stack behind it) and nothing to type: the token is the
// whole credential. On the web the visitor is signed out (a new tab has no
// sessionStorage session) and SessionGate leaves this route alone
// (EMAIL_LINK_GROUPS); "Open Kiwi" then lands on sign-in, which is right.
const EMAIL_UPDATED_LINE = "Your email is updated";
const OPEN_KIWI_LABEL = "Open Kiwi";

type VerifyState =
  | { kind: "verifying" }
  | { kind: "success"; email: string }
  | { kind: "error"; message: string };

export default function VerifyEmail() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { token } = useLocalSearchParams<{ token?: string }>();

  const [state, setState] = useState<VerifyState>(() =>
    token
      ? { kind: "verifying" }
      : { kind: "error", message: INVALID_LINK_MSG },
  );

  // Guard against the verify call firing twice (re-render / strict mode).
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current || !token) return;
    ranRef.current = true;
    (async () => {
      try {
        const { email } = await verifyEmailChange(token);
        // Force /auth/me to refetch so the new email reaches useAuth().user.
        await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
        setState({ kind: "success", email });
      } catch (err) {
        // ApiError.message carries the server's userFacingMessage for the
        // invalid_request / invalid_token / email_taken cases.
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : INVALID_LINK_MSG,
        });
      }
    })();
  }, [token, queryClient]);

  const goHome = () => router.replace("/(tabs)");
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100], paddingTop: insets.top }}>
      <View style={s.body}>
        <KiwiMarkBadge />
        {state.kind === "verifying" && (
          <View style={s.card}>
            <ActivityIndicator color={Colors.sage[700]} />
            <Text style={s.message}>Verifying your new email…</Text>
          </View>
        )}

        {state.kind === "success" && (
          <View style={s.card}>
            <View style={s.iconWrap}>
              <Feather
                name="check-circle"
                size={32}
                color={Colors.sage[700]}
              />
            </View>
            <Text style={s.heading}>{EMAIL_UPDATED_LINE}</Text>
            <View style={s.actionWrap}>
              <Button label={OPEN_KIWI_LABEL} variant="primary" onPress={goHome} />
            </View>
          </View>
        )}

        {state.kind === "error" && (
          <View style={s.card}>
            <View style={s.iconWrap}>
              <Feather
                name="alert-triangle"
                size={32}
                color={Colors.terracotta[600]}
              />
            </View>
            <Text style={s.heading}>Couldn't verify email</Text>
            <Text style={s.message}>{state.message}</Text>
            <View style={s.actionWrap}>
              <Button label="Back to home" variant="primary" onPress={goHome} />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  body: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: Spacing[4],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[5],
    alignItems: "center",
    gap: Spacing[3],
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    textAlign: "center",
  },
  message: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 20,
  },
  actionWrap: {
    alignSelf: "stretch",
    marginTop: Spacing[2],
  },
});
