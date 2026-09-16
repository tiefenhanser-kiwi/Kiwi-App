// /wizard — the Kitchen Wizard in PREFERENCES mode.
//
// WS9 Redesign Arc Block 2a Part C (D-WS9-237) — this screen and /tellkiwi
// were near-clones; both now mount ONE component, components/WizardScreen.tsx,
// with a `mode`. The route name stays: Home's "Have Kiwi use my preferences",
// the Pick screen's exhausted card ("Refine preferences" → `adjust:"1"` opens
// the saved-prefs disclosure) and older links address it.

import React, { useEffect } from "react";
import { useLocalSearchParams } from "expo-router";

import { WizardScreen } from "@/components/WizardScreen";

export default function Wizard() {
  // PRD §9.4 — when launched from the AddMealToPlanSheet "Create new plan"
  // path, the meal id we should attach to the new plan arrives as a route
  // param. WS5: param plumbing only — attach + redirect land later.
  const params = useLocalSearchParams<{
    addMealId?: string;
    adjust?: string;
    nonce?: string;
  }>();

  useEffect(() => {
    if (params.addMealId) {
      console.log("[wizard] received addMealId", params.addMealId);
    }
  }, [params.addMealId]);

  return (
    <WizardScreen
      mode="prefs"
      adjustOpen={params.adjust === "1"}
      paramNonce={params.nonce}
    />
  );
}
