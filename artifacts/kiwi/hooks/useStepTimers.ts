// WS7-8b Block 4 (Block 1) — shared per-step timer state hook.
//
// Lifted from CookSessionView (the wall-clock endsAt/nowMs state + the single 1s
// tick + the once-per-timer completion haptic). Timers are keyed by a stable
// step key (NOT index — survives a re-filter). One `endsAt` per timer + one
// ticking `nowMs`; every chip derives remaining = endsAt - now, so concurrency
// and continuation-while-navigating are inherent.
//
// ⚠️ The original header said this was extracted "so both the Cook screen and
// the Week Prep screen drive the same TimerChip". Week Prep never did: verified
// Sept 30, TimerChip's only importer is components/CookSessionView.tsx and this
// hook's only importer is the same file. Cook Mode is the whole consumer list.
//
// ── D-WS9-289 (Sept 30) — a local notification when a timer runs out ────────
//
// iOS ONLY, by ruling. The full reasoning — expo-notifications falls back to
// Android's INEXACT alarm path without SCHEDULE_EXACT_ALARM, which Android
// documents as "within one hour of the supplied trigger time" — lives in
// lib/cooking/timerNotifications.ts. Android keeps the completion haptic below
// and gets no permission prompt at all.
//
// This hook owns only the three call sites; every decision (when to ask, when to
// schedule, when to cancel) is in that module, behind an injected seam.

import { useEffect, useRef, useState } from "react";
import * as Haptics from "expo-haptics";

import { isTimerDone, type ActiveTimer } from "@/lib/cooking/timer";
import { createLiveTimerNotifier } from "@/lib/cooking/liveTimerNotifier";
import type { TimerNotifier } from "@/lib/cooking/timerNotifications";

export interface StepTimers {
  timers: Record<string, ActiveTimer>;
  nowMs: number;
  /** `label` is what a notification announces; falls back to the step key. */
  startTimer: (step: { key: string; estimatedMinutes: number; label?: string }) => void;
  clearTimer: (key: string) => void;
  extendTimer: (key: string) => void;
}

export interface UseStepTimersDeps {
  /** Injected by the tests; production builds the live expo-notifications one. */
  notifier?: TimerNotifier;
}

export function useStepTimers(deps: UseStepTimersDeps = {}): StepTimers {
  const [timers, setTimers] = useState<Record<string, ActiveTimer>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const firedRef = useRef<Set<string>>(new Set());

  // ⚠️ THE REF IS THE AUTHORITY, and the three mutators write it SYNCHRONOUSLY
  // before calling setTimers with it.
  //
  // This replaced the functional `setTimers(t => ...)` updaters, and the reason
  // is D-WS9-289, not style: extendTimer has to know the new `endsAt` in order
  // to reschedule the notification, and computing it inside a state updater
  // would put I/O in a reducer — which React is free to invoke twice (it does,
  // in dev/StrictMode), scheduling two alerts for one tap. A synchronously
  // maintained ref gives the same batching safety a functional updater does
  // (two mutators in one tick each see the other's write) while keeping the
  // derived value available at the call site where the side effect belongs.
  const timersRef = useRef<Record<string, ActiveTimer>>({});

  // One notifier per mount, built lazily, so the module's permission state — in
  // particular a DENIAL, which must not be re-asked this session — is stable for
  // the whole cook session.
  const notifierRef = useRef<TimerNotifier | null>(deps.notifier ?? null);
  const getNotifier = (): TimerNotifier => {
    if (notifierRef.current === null) notifierRef.current = createLiveTimerNotifier();
    return notifierRef.current;
  };
  // Labels by key, so extendTimer reschedules with the same announcement without
  // the caller having to pass it twice.
  const labelsRef = useRef<Record<string, string>>({});

  const hasActiveTimers = Object.keys(timers).length > 0;

  // One shared 1s tick, only while at least one timer is running.
  //
  // ⚠️ THIS CLEANUP CANCELS THE INTERVAL AND MUST NEVER CANCEL A NOTIFICATION.
  // D-WS9-289 is explicit: leaving Cook Mode does NOT cancel a pending alert,
  // because the food is still cooking. Walking away from the stove is the exact
  // case the notification exists to serve, so an unmount cleanup that "tidied
  // up" scheduled alerts would delete the feature while looking like hygiene.
  // Pinned by "leaving Cook Mode does NOT cancel a scheduled notification" in
  // hooks/__tests__/useStepTimers.test.ts, which exists because this is the most
  // natural wrong thing to add to this file.
  useEffect(() => {
    if (!hasActiveTimers) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveTimers]);

  // Completion: a single success haptic per timer, guarded so it fires once.
  // On Android this stays the entire completion signal.
  useEffect(() => {
    for (const [key, timer] of Object.entries(timers)) {
      if (isTimerDone(timer, nowMs) && !firedRef.current.has(key)) {
        firedRef.current.add(key);
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
      }
    }
  }, [nowMs, timers]);

  const startTimer = (step: {
    key: string;
    estimatedMinutes: number;
    label?: string;
  }) => {
    const durationMs = step.estimatedMinutes * 60_000;
    if (durationMs <= 0) return;
    const now = Date.now();
    firedRef.current.delete(step.key); // re-arm if restarted
    // Stamp `now` to the same instant as endsAt so the chip shows the exact
    // starting value immediately (e.g. "5:00", not "4:59") before the 1s tick.
    setNowMs(now);
    const endsAt = now + durationMs;
    timersRef.current = {
      ...timersRef.current,
      [step.key]: { endsAt, durationMs },
    };
    setTimers(timersRef.current);

    // D-WS9-289 — the FIRST start is where the permission ask lands. Fire and
    // forget: the chip and the countdown are already on screen, and neither a
    // denial nor a failed schedule may block or alter them.
    const label = step.label ?? step.key;
    labelsRef.current[step.key] = label;
    void getNotifier().schedule(step.key, label, endsAt).catch(() => {});
  };

  const clearTimer = (key: string) => {
    firedRef.current.delete(key);
    const next = { ...timersRef.current };
    delete next[key];
    timersRef.current = next;
    setTimers(next);

    // Dismissing the chip cancels the alert — the user saying "done with this
    // timer", which is the one cancellation D-WS9-289 asks for.
    delete labelsRef.current[key];
    void getNotifier().cancel(key).catch(() => {});
  };

  // "Add a minute", state-dependent:
  //   • running timer → push the original end out by a minute (endsAt + 60s).
  //   • done timer    → re-arm to a fresh 1:00 from now (now + 60s).
  // Either way re-arm the completion haptic and refresh `nowMs` so the chip
  // updates on the same tap.
  const extendTimer = (key: string) => {
    const cur = timersRef.current[key];
    if (!cur) return;
    const now = Date.now();
    const endsAt = isTimerDone(cur, now) ? now + 60_000 : cur.endsAt + 60_000;
    timersRef.current = {
      ...timersRef.current,
      [key]: { endsAt, durationMs: cur.durationMs + 60_000 },
    };
    setTimers(timersRef.current);
    firedRef.current.delete(key);
    setNowMs(now);

    // D-WS9-289 — RESCHEDULE. The notifier cancels the pending alert before
    // scheduling the new one, so one timer never holds two.
    void getNotifier()
      .schedule(key, labelsRef.current[key] ?? key, endsAt)
      .catch(() => {});
  };

  return { timers, nowMs, startTimer, clearTimer, extendTimer };
}
