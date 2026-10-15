// BOOK-1C1 (D-WS9-312) — which season band the Cookbook shows, and its ✕.
//
// The live seasons come from the server (GET /cookbook/seasons, already
// windowed and counted under the user's allergies); the dismissals come from
// this device's storage, keyed per user (lib/cookbook/seasons.ts). Until the
// dismissals have loaded nothing shows, so a dismissed band never flashes.

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { useCookbookSeasons } from "@/hooks/useCookbook";
import type { Season } from "@/lib/api/cookbook";
import {
  dismissalKey,
  dismissSeason,
  loadSeasonDismissals,
  seasonBandVisible,
} from "@/lib/cookbook/seasons";

export function useSeasonBand(): { season: Season | null; dismiss: () => void } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const seasons = useCookbookSeasons();
  const [dismissed, setDismissed] = useState<Set<string> | null>(null);

  useEffect(() => {
    let live = true;
    void loadSeasonDismissals().then((set) => {
      if (live) setDismissed(set);
    });
    return () => {
      live = false;
    };
  }, []);

  const data = seasons.data;
  const season =
    data && dismissed && userId
      ? (data.seasons.find((s) =>
          seasonBandVisible(s, data.asOf, dismissed.has(dismissalKey(userId, s))),
        ) ?? null)
      : null;

  const dismiss = useCallback(() => {
    if (!season || !userId || !dismissed) return;
    const key = dismissalKey(userId, season);
    // Hide now; the write follows.
    setDismissed(new Set([...dismissed, key]));
    void dismissSeason(key, dismissed);
  }, [season, userId, dismissed]);

  return { season, dismiss };
}
