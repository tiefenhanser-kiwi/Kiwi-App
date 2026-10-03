// True once `active` has held continuously for `delayMs`; false the moment it
// drops. Prep the Week uses it so a cached generate (a cheap cacheHit) resolves
// before the full loading screen ever paints, rather than flashing it for a
// frame or two on the way to the real content.

import { useEffect, useState } from "react";

export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(t);
      setElapsed(false);
    };
  }, [active, delayMs]);

  return active && elapsed;
}
