// WS9 Redesign Arc Block 2b Part B (D-WS9-234) — the "Add meals" completion:
// toPlaylist=1 → save → POST /me/playlist → invalidate → land on the tab. The
// builder (app/**) calls this with its side effects injected; the sequence and
// the failure behaviour are pinned here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { completePlaylistSave } from "../playlistAfterSave";
import { resolvePostSaveNav } from "../postSaveNav";

function harness(addImpl?: (id: string) => Promise<unknown>) {
  const log: string[] = [];
  const deps = {
    addToPlaylist: async (id: string) => {
      log.push(`add:${id}`);
      if (addImpl) return addImpl(id);
      return { playlistMeal: { id: "pm1", mealId: id, sourceMealId: null, forked: false, createdAt: "" } };
    },
    invalidatePlaylist: () => {
      log.push("invalidate");
    },
    goToPlaylist: () => {
      log.push("navigate");
    },
    onAddFailed: (msg: string) => {
      log.push(`failed:${msg}`);
    },
  };
  return { deps, log };
}

test("toPlaylist=1 → the resolver picks the playlist landing → POST with the NEW id, invalidate, then navigate — in that order", async () => {
  const nav = resolvePostSaveNav({ newMealId: "m-new", toPlaylist: true });
  assert.equal(nav.kind, "playlist");
  const { deps, log } = harness();
  const result = await completePlaylistSave("m-new", deps);
  assert.equal(result, "added");
  // 🔴 THE BREAK THIS CATCHES: dropping the POST after save.
  assert.deepEqual(log, ["add:m-new", "invalidate", "navigate"]);
});

test("a failed add still lands on the tab (the meal IS saved) and surfaces the failure", async () => {
  const { deps, log } = harness(async () => {
    throw new Error("network down");
  });
  const result = await completePlaylistSave("m-new", deps);
  assert.equal(result, "add-failed");
  assert.deepEqual(log, ["add:m-new", "failed:network down", "invalidate", "navigate"]);
});

test("no toPlaylist → the resolver never picks the playlist landing", () => {
  assert.equal(resolvePostSaveNav({ newMealId: "m-new" }).kind, "meal-detail");
});
