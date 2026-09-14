import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Spacing, Typography } from "@/constants/tokens";

// D-WS9-241 B (BUG-258) — what a cold start shows when /auth/me timed out,
// the network failed, or the server 5xx'd WITH a token in hand. The token is
// kept: "Try again" re-runs the bootstrap under its deadline; "Sign out" is
// the user's explicit choice to drop the session (local teardown only — the
// server is unreachable by definition here).
//
// Rendered by app/_layout.tsx IN PLACE OF the navigator, so it covers a cold
// start on any route (a deep link, "(tabs)", "/") — nothing underneath can
// redirect or evict while this is up. Rejected shapes: retry-forever with a
// spinner (the Sept 12 instance was a stopped api-server; that spins all
// night) and auto-sign-out on a network failure (punishes a subway ride).
//
// Living in components/ rather than app/ keeps it inside the test glob.

export const BOOTSTRAP_FAILED_COPY = {
  heading: "Can't reach Kiwi",
  body: "Check your connection and try again.",
  retry: "Try again",
  signOut: "Sign out",
} as const;

interface Props {
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function BootstrapFailedScreen({ onRetry, onSignOut }: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = React.useState<"retry" | "signOut" | null>(null);

  const run = async (which: "retry" | "signOut", fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(which);
    try {
      await fn();
    } catch (err) {
      // retryBootstrap never throws (its outcome is bootstrapStatus);
      // abandonBootstrap can if native storage refuses the clear. Either way
      // the screen stays usable — the buttons come back.
      console.warn(`[bootstrap-failed] ${which} threw:`, err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View
      testID="bootstrap-failed"
      style={[
        styles.bg,
        { paddingTop: insets.top + Spacing[6], paddingBottom: insets.bottom + Spacing[4] },
      ]}
    >
      <View style={styles.center}>
        <Feather name="wifi-off" size={40} color={Colors.sage[700]} />
        <Text style={styles.heading}>{BOOTSTRAP_FAILED_COPY.heading}</Text>
        <Text style={styles.body}>{BOOTSTRAP_FAILED_COPY.body}</Text>
      </View>
      <View style={styles.actions}>
        <Button
          testID="bootstrap-retry"
          label={BOOTSTRAP_FAILED_COPY.retry}
          onPress={() => void run("retry", onRetry)}
          loading={busy === "retry"}
          disabled={busy === "signOut"}
        />
        <Button
          testID="bootstrap-sign-out"
          label={BOOTSTRAP_FAILED_COPY.signOut}
          variant="ghost"
          onPress={() => void run("signOut", onSignOut)}
          loading={busy === "signOut"}
          disabled={busy === "retry"}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: Palette.background.app,
    paddingHorizontal: Spacing[5],
    justifyContent: "space-between",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing[3],
  },
  heading: {
    fontSize: Typography.fontSize.xl * 1.2,
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    color: Colors.neutral[900],
    textAlign: "center",
  },
  body: {
    fontSize: Typography.fontSize.md,
    fontFamily: Typography.face.sans[400],
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
  },
  actions: {
    gap: Spacing[3],
  },
});
