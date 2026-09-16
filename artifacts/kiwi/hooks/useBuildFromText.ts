import { useMutation } from "@tanstack/react-query";

import {
  buildFromText,
  type BuildFromTextInput,
  type BuildFromTextResult,
} from "@/lib/api/tellKiwi";

export function useBuildFromText() {
  return useMutation<BuildFromTextResult, Error, BuildFromTextInput>({
    // D-WS9-191 — buildFromText gained an optional second arg (the "another"
    // extras); react-query passes a context object there, so bind the input
    // only. This hook is the FIRST build and never sends extras.
    mutationFn: (input) => buildFromText(input),
  });
}
