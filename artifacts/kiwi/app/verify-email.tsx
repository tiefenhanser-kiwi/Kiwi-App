import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { verifyEmailChange } from "@/lib/api/me";

// WS7-2 Block D (Commit 1): the verify-side landing screen for the two-step
// email change. Reached as the deep link kiwi://verify-email?token=... — the
// request side (profile.tsx, Block C) emails this link. The JWT in `token`
// IS the auth, so the screen needs no session; verifyEmailChange() sends no
// bearer. On success we invalidate ['auth','me'] so /auth/me refetches and
// the new email lands in useAuth().user. Routing always lands on /(tabs);
// a logged-out user is then bounced to auth by index.tsx's state machine.

const INVALID_LINK_MSG = "This verification link is invalid or expired.";

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

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Verify email" />
      <View style={s.body}>
        {state.kind === "verifying" && (
          <View style={s.card}>
            <ActivityIndicator color={KColors.sage[700]} />
            <Text style={s.message}>Verifying your new email…</Text>
          </View>
        )}

        {state.kind === "success" && (
          <View style={s.card}>
            <View style={s.iconWrap}>
              <Feather
                name="check-circle"
                size={32}
                color={KColors.sage[700]}
              />
            </View>
            <Text style={s.heading}>Email updated</Text>
            <Text style={s.message}>
              Your email has been updated to {state.email}.
            </Text>
            <View style={s.actionWrap}>
              <Button label="Continue" variant="primary" onPress={goHome} />
            </View>
          </View>
        )}

        {state.kind === "error" && (
          <View style={s.card}>
            <View style={s.iconWrap}>
              <Feather
                name="alert-triangle"
                size={32}
                color={KColors.terracotta[600]}
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
    paddingHorizontal: KSpacing.lg,
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.xl,
    alignItems: "center",
    gap: KSpacing.md,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: KColors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  message: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  actionWrap: {
    alignSelf: "stretch",
    marginTop: KSpacing.sm,
  },
});
