// WS7-8b Block 4 (Block 1) — shared per-step timer state hook.
//
// Lifted VERBATIM from CookSessionView (the wall-clock endsAt/nowMs state + the
// single 1s tick + the once-per-timer completion haptic) so both the Cook screen
// and the Week Prep screen drive the same TimerChip with one source of truth.
// Timers are keyed by a stable step key (NOT index — survives a re-filter). One
// `endsAt` per timer + one ticking `nowMs`; every chip derives remaining =
// endsAt - now, so concurrency and continuation-while-navigating are inherent.
//
// No logic change from the original inline implementation; `startTimer` is
// widened to accept any `{ key, estimatedMinutes }` (CookStep satisfies it).

import { useEffect, useRef, useState } from "react";
import * as Haptics from "expo-haptics";

import { isTimerDone, type ActiveTimer } from "@/lib/cooking/timer";

export interface StepTimers {
  timers: Record<string, ActiveTimer>;
  nowMs: number;
  startTimer: (step: { key: string; estimatedMinutes: number }) => void;
  clearTimer: (key: string) => void;
  extendTimer: (key: string) => void;
}

export function useStepTimers(): StepTimers {
  const [timers, setTimers] = useState<Record<string, ActiveTimer>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const firedRef = useRef<Set<string>>(new Set());

  const hasActiveTimers = Object.keys(timers).length > 0;

  // One shared 1s tick, only while at least one timer is running.
  useEffect(() => {
    if (!hasActiveTimers) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveTimers]);

  // Completion: a single success haptic per timer, guarded so it fires once.
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

  const startTimer = (step: { key: string; estimatedMinutes: number }) => {
    const durationMs = step.estimatedMinutes * 60_000;
    if (durationMs <= 0) return;
    const now = Date.now();
    firedRef.current.delete(step.key); // re-arm if restarted
    // Stamp `now` to the same instant as endsAt so the chip shows the exact
    // starting value immediately (e.g. "5:00", not "4:59") before the 1s tick.
    setNowMs(now);
    setTimers((t) => ({
      ...t,
      [step.key]: { endsAt: now + durationMs, durationMs },
    }));
  };

  const clearTimer = (key: string) => {
    firedRef.current.delete(key);
    setTimers((t) => {
      const next = { ...t };
      delete next[key];
      return next;
    });
  };

  // "Add a minute", state-dependent:
  //   • running timer → push the original end out by a minute (endsAt + 60s).
  //   • done timer    → re-arm to a fresh 1:00 from now (now + 60s).
  // Either way re-arm the completion haptic and refresh `nowMs` so the chip
  // updates on the same tap.
  const extendTimer = (key: string) => {
    const now = Date.now();
    setTimers((t) => {
      const cur = t[key];
      if (!cur) return t;
      const endsAt = isTimerDone(cur, now) ? now + 60_000 : cur.endsAt + 60_000;
      return { ...t, [key]: { endsAt, durationMs: cur.durationMs + 60_000 } };
    });
    firedRef.current.delete(key);
    setNowMs(now);
  };

  return { timers, nowMs, startTimer, clearTimer, extendTimer };
}
