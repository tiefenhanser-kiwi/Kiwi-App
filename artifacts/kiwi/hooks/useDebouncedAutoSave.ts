// WS9 3d Part 3c-2 (B2) — debounced auto-save with flush-on-unmount.
//
// Extracted from preferences.tsx so the debounce + flush state machine is
// unit-testable without rendering the full screen (mirrors the
// dropComposedPlanFromListCache extraction in useCompostWithUndo.ts). The
// screen keeps sending the whole form; this hook decides when the write fires.
//
// Behavior:
//   - The FIRST non-null value is treated as the initial seed (server row →
//     form) and does NOT trigger a save. Every value change after that is a
//     user edit and (re)arms the debounce timer.
//   - Rapid successive edits collapse to a single save: each change clears the
//     prior timer, so only the last value within `delayMs` of quiet is written.
//   - Flush-on-unmount: if the screen unmounts while an edit is still pending
//     (timer armed but not yet fired), the pending value is written on unmount
//     instead of being lost. Previously a fast swipe-back cleared the timer and
//     dropped the edit.
//   - No double-save: the timer callback nulls the pending marker the instant it
//     fires, so an unmount flush that races a just-fired save sees "nothing
//     pending" and does nothing.
//
// `onSave` is expected to own its own error handling (the preferences screen
// wraps it in a try/catch that surfaces a toast); this hook never rejects.

import { useEffect, useRef } from "react";

export interface DebouncedAutoSaveOptions<T> {
  /** Current form value; null before the screen has seeded from the server. */
  value: T | null;
  /** Persist a settled value. Must handle its own errors — this hook `void`s it. */
  onSave: (value: T) => void | Promise<void>;
  /** Quiet-period before a save fires. */
  delayMs: number;
}

export function useDebouncedAutoSave<T>({
  value,
  onSave,
  delayMs,
}: DebouncedAutoSaveOptions<T>): void {
  const seededRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<T | null>(null);
  // Keep the latest onSave reachable from the mount-only unmount effect (which
  // has [] deps and would otherwise capture only the mount-time closure), and
  // so an onSave identity change never reschedules an armed timer.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (value == null) return;
    // Skip the one-time seed (null → server row): not a user edit.
    if (!seededRef.current) {
      seededRef.current = true;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    const snapshot = value;
    pendingRef.current = snapshot;
    timerRef.current = setTimeout(() => {
      // Clear the pending marker BEFORE dispatch so a concurrent unmount flush
      // sees "nothing pending" and cannot re-send this same snapshot.
      pendingRef.current = null;
      timerRef.current = null;
      void onSaveRef.current(snapshot);
    }, delayMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, delayMs]);

  // Mount-only: cleanup runs ONLY on unmount. Flush a still-pending edit.
  useEffect(() => {
    return () => {
      if (pendingRef.current != null) {
        if (timerRef.current) clearTimeout(timerRef.current);
        const pending = pendingRef.current;
        pendingRef.current = null;
        void onSaveRef.current(pending);
      }
    };
  }, []);
}
