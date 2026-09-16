// WS9 Redesign Arc Block 2b Part B (D-WS9-234) — the "Add meals" completion.
//
// The Playlist tab's "Add meals" opens today's Create Meal screen with
// `toPlaylist=1`; every one of its six flows (Ask Kiwi · URL · photo · text ·
// manual · saved dishes) funnels into the Meal Builder's CREATE branch, whose
// resolvePostSaveNav returns { kind: "playlist" } for that param. This is what
// runs next: POST /me/playlist with the NEW meal's id, invalidate the playlist
// query so the tab shows it on top, then land on the tab. Pulled out of
// app/meal-builder.tsx (outside the test glob) with its side effects injected,
// so the sequence — add BEFORE navigate, navigate even when the add fails
// (the meal IS saved; the user must not be stranded on the form) — is pinned.

export interface PlaylistAfterSaveDeps {
  addToPlaylist: (mealId: string) => Promise<unknown>;
  invalidatePlaylist: () => void | Promise<unknown>;
  /** Land on the Playlist tab (the builder uses router.dismissTo). */
  goToPlaylist: () => void;
  /** Surface an add failure — the meal is saved, only the playlist step failed. */
  onAddFailed: (message: string) => void;
}

export type PlaylistAfterSaveResult = "added" | "add-failed";

export async function completePlaylistSave(
  newMealId: string,
  deps: PlaylistAfterSaveDeps,
): Promise<PlaylistAfterSaveResult> {
  let result: PlaylistAfterSaveResult = "added";
  try {
    await deps.addToPlaylist(newMealId);
  } catch (err) {
    result = "add-failed";
    deps.onAddFailed(
      err instanceof Error && err.message
        ? err.message
        : "Add it from the meal's page instead.",
    );
  }
  await deps.invalidatePlaylist();
  deps.goToPlaylist();
  return result;
}
