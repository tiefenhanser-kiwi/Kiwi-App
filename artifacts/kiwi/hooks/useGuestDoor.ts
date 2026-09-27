// Row 13 "Test Kitchen" · Block 2 Part D — the thin hook over lib/guest/doors.ts.
//
// The DECISION is the pure guestGuard(); this owns only the sheet's open state
// and the funnel event. Deliberately small: a screen calls `attempt(action, run)`
// where it used to call `run()`, and the guard's verdict decides which happens.
// A member's `attempt` always runs `run` — the hook adds nothing to that path.

import React from "react";

import { useIsGuestSafe } from "@/contexts/GuestContext";
import { trackGuestEvent } from "@/lib/api/guest";
import { guestGuard, type GuestAction } from "@/lib/guest/doors";

export interface UseGuestDoor {
  /** The action whose door is open, or null. */
  door: GuestAction | null;
  close: () => void;
  /** Open a door directly (for a CTA that has no member behaviour at all). */
  open: (action: GuestAction) => void;
  /**
   * Run `action`'s effect, or open the door instead. Returns true when the
   * effect ran — so a caller that must not proceed can `if (!attempt(...)) return;`
   *
   * 🔴 The `door_tapped` event is fired HERE, once, with which door in `meta`
   * (R11), so no screen can wire a door and forget the funnel row.
   */
  attempt: (action: GuestAction, run?: () => void) => boolean;
}

export function useGuestDoor(): UseGuestDoor {
  // The non-throwing read: this hook is mounted by WizardScreen, which is shared
  // with the member app and rendered bare by its own component tests.
  const isGuest = useIsGuestSafe();
  const [door, setDoor] = React.useState<GuestAction | null>(null);

  const attempt = React.useCallback(
    (action: GuestAction, run?: () => void): boolean => {
      if (guestGuard({ isGuest, action }) === "door") {
        // Best-effort; never awaited, never blocking (R11).
        void trackGuestEvent("door_tapped", { step: action, meta: { door: action } });
        setDoor(action);
        return false;
      }
      run?.();
      return true;
    },
    [isGuest],
  );

  const open = React.useCallback((action: GuestAction) => {
    void trackGuestEvent("door_tapped", { step: action, meta: { door: action } });
    setDoor(action);
  }, []);

  const close = React.useCallback(() => setDoor(null), []);

  return { door, close, open, attempt };
}
