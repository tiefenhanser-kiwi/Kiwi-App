// WS9 Redesign Arc Block 2a (D-WS9-245) — <MixDials>, the one component the
// preferences screen, onboarding step 2 and the merged wizard all render for
// the two mix dials. The screens themselves sit under app/** (outside the test
// glob, D-WS9-164), so the behaviour that matters is pinned HERE, on the
// component they share: four chips per dial, the enum key on tap, All forcing
// None, and the zero-playlist nudge replacing the Playlist row.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  DISCOVERY_DIAL_LABEL,
  MixDials,
  NUDGE_LINK,
  NUDGE_TITLE,
  PLAYLIST_DIAL_LABEL,
} from "../MixDials";
import type { DialState } from "@/lib/wizard/dials";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

let mounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => walk(c))
    : [];
  return [node, ...kids];
}
function allText(node: Json | string | null): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}
/** Every onPress-bearing node whose own descendant text is exactly `label`. */
function pressablesByExactText(root: Json, label: string): Json[] {
  return walk(root).filter(
    (n) =>
      (n.props as { onPress?: unknown }).onPress &&
      allText(n).join("") === label,
  );
}

function render(props: { value: DialState; playlistCount?: number }) {
  const changes: DialState[] = [];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(MixDials, {
        ...props,
        onChange: (next: DialState) => changes.push(next),
      }),
    );
  });
  mounted = tree;
  return { root: tree.toJSON() as unknown as Json, changes };
}

const NONE_NONE: DialState = { playlistLevel: "none", discoveryLevel: "none" };

test("renders BOTH rows, Playlist above Discovery, four chips each", () => {
  const { root } = render({ value: NONE_NONE, playlistCount: 3 });
  const text = allText(root);
  const playlistAt = text.indexOf(PLAYLIST_DIAL_LABEL);
  const discoveryAt = text.indexOf(DISCOVERY_DIAL_LABEL);
  assert.ok(playlistAt >= 0 && discoveryAt >= 0, "both labels render");
  assert.ok(playlistAt < discoveryAt, "Playlist must sit ABOVE Discovery");
  // Four chips per dial: each label appears exactly twice (once per row).
  for (const label of ["None", "Some", "Mostly", "All"]) {
    assert.equal(
      pressablesByExactText(root, label).length,
      2,
      `${label}: expected one chip per dial`,
    );
  }
  assert.ok(!text.includes(NUDGE_TITLE), "no nudge when the playlist has meals");
});

test("a tap emits the ENUM key for that dial and leaves the other alone", () => {
  const { root, changes } = render({ value: NONE_NONE, playlistCount: 3 });
  // The first "Mostly" chip is the Playlist row's (it renders first).
  const [playlistMostly, discoveryMostly] = pressablesByExactText(root, "Mostly");
  act(() => {
    (playlistMostly.props.onPress as () => void)();
  });
  assert.deepEqual(changes.at(-1), { playlistLevel: "mostly", discoveryLevel: "none" });
  act(() => {
    (discoveryMostly.props.onPress as () => void)();
  });
  assert.deepEqual(changes.at(-1), { playlistLevel: "none", discoveryLevel: "mostly" });
  // Never an integer — the whole point of Block 2a's Part A.
  for (const c of changes) {
    assert.equal(typeof c.playlistLevel, "string");
    assert.equal(typeof c.discoveryLevel, "string");
  }
});

test("All on one dial forces the OTHER to None (server rule mirrored)", () => {
  const { root, changes } = render({
    value: { playlistLevel: "some", discoveryLevel: "some" },
    playlistCount: 3,
  });
  const [, discoveryAll] = pressablesByExactText(root, "All");
  act(() => {
    (discoveryAll.props.onPress as () => void)();
  });
  assert.deepEqual(changes.at(-1), { playlistLevel: "none", discoveryLevel: "all" });
});

test("zero playlist meals → the nudge card REPLACES the Playlist row", () => {
  const { root } = render({ value: NONE_NONE, playlistCount: 0 });
  const text = allText(root);
  assert.ok(text.includes(NUDGE_TITLE), "nudge title missing");
  assert.ok(text.includes(NUDGE_LINK), "nudge link missing");
  assert.ok(!text.includes(PLAYLIST_DIAL_LABEL), "the Playlist row still renders beside the nudge");
  // The Discovery row is untouched by the gate.
  assert.ok(text.includes(DISCOVERY_DIAL_LABEL));
  for (const label of ["None", "Some", "Mostly", "All"]) {
    assert.equal(pressablesByExactText(root, label).length, 1, `${label}: one chip (Discovery only)`);
  }
});

test("an UNKNOWN count (undefined) renders the chips, not the nudge", () => {
  // Onboarding passes nothing; a failed playlist read leaves it undefined.
  // Neither is "the user has no playlist" — the chips are the safe default.
  const { root } = render({ value: NONE_NONE });
  const text = allText(root);
  assert.ok(text.includes(PLAYLIST_DIAL_LABEL));
  assert.ok(!text.includes(NUDGE_TITLE));
});

test("Block 2b (ruled): showPlaylist=false renders Discovery ONLY — no Playlist row, no nudge (onboarding step 2)", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(MixDials, {
        value: NONE_NONE,
        onChange: () => {},
        showPlaylist: false,
        playlistCount: 0,
      }),
    );
  });
  mounted = tree;
  const root = tree.toJSON() as unknown as Json;
  const text = allText(root);
  assert.ok(text.includes(DISCOVERY_DIAL_LABEL));
  assert.ok(!text.includes(PLAYLIST_DIAL_LABEL), "the Playlist row must be hidden");
  assert.ok(!text.includes(NUDGE_TITLE), "count 0 must NOT nudge when the row is hidden");
  for (const label of ["None", "Some", "Mostly", "All"]) {
    assert.equal(pressablesByExactText(root, label).length, 1, `${label}: Discovery only`);
  }
});
