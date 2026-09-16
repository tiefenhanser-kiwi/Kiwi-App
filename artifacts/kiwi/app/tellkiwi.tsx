// /tellkiwi — the Kitchen Wizard in TEXT mode.
//
// WS9 Redesign Arc Block 2a Part C (D-WS9-237) — this screen and /wizard were
// near-clones; both now mount ONE component, components/WizardScreen.tsx, with
// a `mode`. The route name stays: Home's Tell Kiwi send arrow (`text` seeds the
// box — the WS9 3a handoff seam), the Pick screen's exhausted card ("Tell Kiwi"
// → `focus:"1"` puts the caret in the box) and older links address it.

import React from "react";
import { useLocalSearchParams } from "expo-router";

import { WizardScreen } from "@/components/WizardScreen";

export default function TellKiwi() {
  const params = useLocalSearchParams<{ text?: string; focus?: string }>();
  const initialText = typeof params.text === "string" ? params.text : "";
  return (
    <WizardScreen
      mode="text"
      initialText={initialText}
      focusText={params.focus === "1"}
    />
  );
}
