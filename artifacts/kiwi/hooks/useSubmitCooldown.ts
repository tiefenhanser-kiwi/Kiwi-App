// BUG-296 — hold a screen's submit for N seconds after a rate-limited (429)
// attempt, for the server's Retry-After. The auth screens own their own
// `submitting` flag; this is the second, time-based reason the button is off.
//
// Reuse check (§27.2): lib/cooking/timer.ts + useStepTimers are Cook Mode's
// per-step countdowns (start/pause/extend, rendered mm:ss); a one-shot lockout
// with no display is a different control, and one timeout is the whole of it.

import React from "react";

export interface SubmitCooldown {
  /** True while the hold is running. */
  active: boolean;
  /** Start (or restart) a hold of `seconds`. Non-positive values are ignored. */
  start: (seconds: number) => void;
}

export function useSubmitCooldown(): SubmitCooldown {
  const [active, setActive] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = React.useCallback(
    (seconds: number) => {
      if (!(seconds > 0)) return;
      clear();
      setActive(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setActive(false);
      }, seconds * 1000);
    },
    [clear],
  );

  // Unmount: drop the pending timeout so it never sets state on a dead screen.
  React.useEffect(() => clear, [clear]);

  return { active, start };
}
