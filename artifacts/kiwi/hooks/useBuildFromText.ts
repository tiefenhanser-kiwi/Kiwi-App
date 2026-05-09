import { useMutation } from "@tanstack/react-query";

import {
  buildFromText,
  type BuildFromTextInput,
  type BuildFromTextResult,
} from "@/lib/api/tellKiwi";

export function useBuildFromText() {
  return useMutation<BuildFromTextResult, Error, BuildFromTextInput>({
    mutationFn: buildFromText,
  });
}
