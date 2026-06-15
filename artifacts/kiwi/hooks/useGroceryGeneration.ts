// WS7-7-A B6 (D-WS5-033) — shared plan→grocery generate handoff. Used by both
// the Home "Get Groceries" 1-plan direct case and the multi-plan picker's pick.
// Mirrors app/plan/[id].tsx handleGroceryListPress (the AI pipeline is 5-15s,
// so the in-flight guard + isGenerating flag drive a loading surface) — there
// is ONE generate path, not a parallel one. The result→action mapping is the
// pure resolveGenerateResult in lib/groceryPicker.ts.

import { useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";

import { generateGroceryListForPlan } from "@/lib/api/grocery";
import { resolveGenerateResult } from "@/lib/groceryPicker";

export function useGroceryGeneration() {
  const router = useRouter();
  const [isGenerating, setIsGenerating] = useState(false);

  // Generate (or re-open the existing list for) the given plan, then navigate
  // to /grocery-list/[id]. Guards against double-taps while a generate is in
  // flight. Returns when the handoff resolves (navigate or alert).
  const generate = async (planId: string): Promise<void> => {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const result = await generateGroceryListForPlan(planId);
      const action = resolveGenerateResult(result);
      if (action.kind === "navigate") {
        router.push({
          pathname: "/grocery-list/[id]",
          params: { id: action.listId },
        });
      } else {
        Alert.alert(action.title, action.message);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  return { generate, isGenerating };
}
