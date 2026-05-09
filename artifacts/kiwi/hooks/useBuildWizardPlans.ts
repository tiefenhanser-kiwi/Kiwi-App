import { useMutation } from "@tanstack/react-query";

import {
  buildWizardPlans,
  type BuildWizardPlansResult,
} from "@/lib/api/wizard";
import type { WizardPreferencesInput } from "@/lib/types";

export function useBuildWizardPlans() {
  return useMutation<BuildWizardPlansResult, Error, WizardPreferencesInput>({
    mutationFn: buildWizardPlans,
  });
}
