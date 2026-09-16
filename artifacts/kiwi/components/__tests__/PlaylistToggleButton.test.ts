// WS9 Redesign Arc Block 2b Part B (D-WS9-234) — the Meal Detail toggle.
// Two states read from the cached playlist; add → POST, remove → DELETE; a
// catalog meal's add reports the FORK id so the page can move to it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  __setForTests as seedSecureItem,
  __resetForTests as resetSecureStore,
} from "expo-secure-store";

import { ADD_LABEL, IN_LABEL, PlaylistToggleButton } from "../PlaylistToggleButton";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}
function allText(node: Json | string | null): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}

const originalFetch = globalThis.fetch;
let playlistIds: string[] = [];
let calls: { path: string; method: string; body: unknown }[] = [];
let forkOnAdd: string | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function card(id: string) {
  return {
    id, title: `Meal ${id}`, description: null, cuisineType: null, difficulty: "easy",
    estimatedTimeMinutes: 30, activeTimeMinutes: 10,
    macrosPerServing: { calories: 1, protein: 1, carbs: 1, fat: 1 },
    tags: [], dishCount: 1, isPlaylist: true, isNewToYou: false, source: "playlist", addedAt: "",
  };
}

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  calls = [];
  playlistIds = [];
  forkOnAdd = null;
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const path = u.slice(u.indexOf("/api") + 4);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/me/playlist" && method === "GET")
      return Promise.resolve(jsonResponse({ playlist: playlistIds.map(card), count: playlistIds.length }));
    if (path === "/me/playlist" && method === "POST") {
      const bound = forkOnAdd ?? (body as { mealId: string }).mealId;
      playlistIds = [bound, ...playlistIds];
      return Promise.resolve(
        jsonResponse(
          {
            playlistMeal: {
              id: "pm1", mealId: bound, sourceMealId: forkOnAdd ? (body as { mealId: string }).mealId : null,
              forked: !!forkOnAdd, createdAt: "2026-09-16T00:00:00.000Z",
            },
          },
          201,
        ),
      );
    }
    if (path.startsWith("/me/playlist/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/me/playlist/".length));
      playlistIds = playlistIds.filter((x) => x !== id);
      return Promise.resolve(jsonResponse(null, 204));
    }
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  resetSecureStore();
  globalThis.fetch = originalFetch;
});

let mounted: { renderer: TestRenderer.ReactTestRenderer; client: QueryClient } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted!.renderer.unmount();
    });
    mounted.client.clear();
    mounted = null;
  }
});

async function mount(mealId: string, onForked?: (id: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(PlaylistToggleButton, { mealId, onForked }),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  mounted = { renderer, client };
  const root = () => renderer.toJSON() as unknown as Json;
  return {
    label: () => allText(root()).join(""),
    press: async () => {
      const btn = walk(root()).find((n) => n.props.testID === "playlist-toggle")!;
      await act(async () => {
        (btn.props.onPress as () => void)();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    },
  };
}

test("not in the playlist → 'Add to playlist'; tap → POST /me/playlist { mealId } → 'In your playlist ✓'", async () => {
  const m = await mount("m1");
  assert.equal(m.label(), ADD_LABEL);
  await m.press();
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post, "POST not called");
  assert.deepEqual(post!.body, { mealId: "m1" });
  assert.equal(m.label(), IN_LABEL);
});

test("in the playlist → 'In your playlist ✓'; tap → DELETE /me/playlist/:id → 'Add to playlist'", async () => {
  playlistIds = ["m1"];
  const m = await mount("m1");
  assert.equal(m.label(), IN_LABEL);
  await m.press();
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "DELETE not called");
  assert.equal(del!.path, "/me/playlist/m1");
  assert.equal(m.label(), ADD_LABEL);
});

test("a catalog meal's add returns the FORK id → onForked(forkId), never assumed to be the id sent", async () => {
  forkOnAdd = "fork-9";
  const forked: string[] = [];
  const m = await mount("catalog-1", (id) => forked.push(id));
  await m.press();
  assert.deepEqual(forked, ["fork-9"]);
  // The catalog page itself still reads "not in playlist" — the fork is what
  // the playlist holds; Meal Detail moves to the fork on onForked.
  assert.equal(m.label(), ADD_LABEL);
});
