import { useMutation } from "@tanstack/react-query";

import {
  buildWizardPlans,
  type BuildWizardPlansResult,
} from "@/lib/api/wizard";
import type { WizardPreferencesInput } from "@/lib/types";

export function useBuildWizardPlans() {
  return useMutation<BuildWizardPlansResult, Error, WizardPreferencesInput>({
    // Wrap rather than pass buildWizardPlans directly: it gained an optional
    // second `exclude` param (BUG-053), which would otherwise collide with the
    // MutationFunctionContext react-query passes as the 2nd arg. This legacy
    // buffered hook threads no exclusion.
    mutationFn: (input) => buildWizardPlans(input),
  });
}
