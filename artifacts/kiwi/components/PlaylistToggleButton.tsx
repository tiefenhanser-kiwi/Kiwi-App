// WS9 Redesign Arc Block 2b Part B (D-WS9-234) — the Meal Detail toggle:
// "Add to playlist" / "In your playlist ✓".
//
// Membership is read from GET /me/playlist (the cached query the tab and the
// wizard already share) — NOT a new field on the meal. Add → POST /me/playlist;
// remove → DELETE /me/playlist/:id; both invalidate the playlist query and let
// the refetch settle the state (no optimistic flip: the POST's answer matters).
//
// ⚠️ A PUBLIC CATALOG MEAL COMES BACK AS THE USER'S FORK (D-WS7-139 fork-on-
// acquire): `playlistMeal.mealId` ≠ the id sent. The playlist then holds the
// FORK, so membership-by-id on the catalog page would read "not in playlist"
// right after adding. The button reports the fork id through `onForked`; Meal
// Detail replaces itself with the fork's page (the user's own copy — the one
// that IS in the playlist, and the one Edit / Cook operate on). The playlist
// card carries no `sourceStoreMealId` today, so lineage cannot be checked from
// the client — CANDIDATE for the server.
//
// Sits beside the existing actions; the favorites heart is untouched (WS7-11
// reconciles the two later).

import React from "react";
import { Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import {
  addToPlaylist,
  getPlaylist,
  PLAYLIST_QUERY_KEY,
  removeFromPlaylist,
  type AddToPlaylistResponse,
} from "@/lib/api/playlist";

export const ADD_LABEL = "Add to playlist";
export const IN_LABEL = "In your playlist ✓";

interface Props {
  mealId: string;
  /** The POST returned a different id — the user's fork of a catalog meal. */
  onForked?: (forkMealId: string) => void;
}

export function PlaylistToggleButton({ mealId, onForked }: Props) {
  const queryClient = useQueryClient();
  const playlistQuery = useQuery({ queryKey: PLAYLIST_QUERY_KEY, queryFn: getPlaylist });
  const inPlaylist = !!playlistQuery.data?.playlist.some((m) => m.id === mealId);

  const addMutation = useMutation<AddToPlaylistResponse, Error, string>({
    mutationFn: addToPlaylist,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: PLAYLIST_QUERY_KEY });
      if (res.playlistMeal.mealId !== mealId) onForked?.(res.playlistMeal.mealId);
    },
    onError: (err) =>
      Alert.alert(
        "Couldn't add to your playlist",
        err.message || "Something went wrong. Please try again.",
      ),
  });
  const removeMutation = useMutation<void, Error, string>({
    mutationFn: removeFromPlaylist,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLAYLIST_QUERY_KEY }),
    onError: (err) =>
      Alert.alert(
        "Couldn't update your playlist",
        err.message || "Something went wrong. Please try again.",
      ),
  });

  const busy = addMutation.isPending || removeMutation.isPending || playlistQuery.isLoading;

  return (
    <Button
      label={inPlaylist ? IN_LABEL : ADD_LABEL}
      variant={inPlaylist ? "tint" : "ghost"}
      onPress={() =>
        inPlaylist ? removeMutation.mutate(mealId) : addMutation.mutate(mealId)
      }
      disabled={busy}
      testID="playlist-toggle"
    />
  );
}
