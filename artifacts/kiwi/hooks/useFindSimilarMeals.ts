import { useMutation } from "@tanstack/react-query";

import {
  findSimilarMeals,
  type FindSimilarRequest,
  type FindSimilarResponse,
} from "@/lib/api/meals";

export function useFindSimilarMeals() {
  return useMutation<FindSimilarResponse, Error, FindSimilarRequest>({
    mutationFn: findSimilarMeals,
  });
}
