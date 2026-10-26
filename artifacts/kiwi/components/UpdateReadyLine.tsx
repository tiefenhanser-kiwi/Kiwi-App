import React, { useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, type AppStateStatus } from "react-native";
import { useSegments } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Updates from "expo-updates";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  UPDATE_LINE_MS,
  UPDATE_LINE_TEXT,
  checkAndFetchUpdate,
  shouldCheckForUpdate,
  updateLineVisible,
} from "@/lib/updatePrompt";

// BUG-525 (1.2-NATIVE A) — the live half of lib/updatePrompt.ts. Mounted once
// in app/_layout.tsx, above the navigator, like ToastProvider's toast.
//
// The launch itself is left to expo-updates (checkAutomatically ON_LOAD): it
// checks and downloads natively, and useUpdates() reports the download as
// isUpdatePending. This adds the check a warm phone never gets: on each
// return to the foreground, at most every UPDATE_CHECK_MIN_GAP_MS.

/** Off on web (no OTA) and in a dev build (Metro serves the JS). A constant,
 *  so the layout mounts the component or never does. */
export const UPDATE_LINE_ENABLED = Platform.OS !== "web" && Updates.isEnabled;

export function UpdateReadyLine() {
  const { isUpdatePending } = Updates.useUpdates();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(false);
  // Read by the AppState listener; written in effects only (reactCompiler).
  const pendingRef = useRef(isUpdatePending);
  const lastCheckRef = useRef<number | null>(null);

  useEffect(() => {
    pendingRef.current = isUpdatePending;
    if (isUpdatePending) setShown(true);
  }, [isUpdatePending]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), UPDATE_LINE_MS);
    return () => clearTimeout(t);
  }, [shown]);

  useEffect(() => {
    // The launch's own native check counts as the first one.
    lastCheckRef.current = Date.now();
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next !== "active") return;
      if (pendingRef.current) {
        setShown(true);
        return;
      }
      const now = Date.now();
      if (
        !shouldCheckForUpdate({
          platform: Platform.OS,
          isEnabled: Updates.isEnabled,
          isPending: false,
          lastCheckAt: lastCheckRef.current,
          now,
        })
      ) {
        return;
      }
      lastCheckRef.current = now;
      // A download flips useUpdates().isUpdatePending, which shows the line.
      void checkAndFetchUpdate(Updates);
    });
    return () => sub.remove();
  }, []);

  if (!shown || !updateLineVisible(isUpdatePending, segments[0])) return null;

  return (
    <Pressable
      style={({ pressed }) => [s.line, { top: insets.top + Spacing[2] }, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
      accessibilityLabel={UPDATE_LINE_TEXT}
      onPress={() => {
        void Updates.reloadAsync().catch(() => {});
      }}
    >
      <Text style={s.text}>{UPDATE_LINE_TEXT}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  line: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[2],
  },
  text: {
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
});
