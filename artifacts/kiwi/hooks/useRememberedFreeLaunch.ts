import { useEffect, useState } from "react";

import {
  loadRememberedBillingMode,
  preAuthFreeLaunch,
  type BillingMode,
} from "@/lib/billing/mode";

/**
 * CLIENT-7 A (D-WS9-356) — Welcome and Sign-up, before anyone signs in: true
 * unless the last server this device heard from said "enforced". Starts true
 * (the fresh-install answer) and settles once storage has been read.
 */
export function useRememberedFreeLaunch(): boolean {
  const [mode, setMode] = useState<BillingMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadRememberedBillingMode().then((m) => {
      if (!cancelled) setMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return preAuthFreeLaunch(mode);
}
