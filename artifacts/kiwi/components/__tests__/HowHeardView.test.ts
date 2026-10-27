// CLIENT-3 D (ATTR) — the "How did you hear about Kiwi?" view: one tap answers,
// "A creator" opens a "who?" box with its own Continue, Skip is always there.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { HowHeardView } from "../HowHeardView";

interface Node {
  children?: Array<Node | string>;
}
function texts(n: Node | string | null, out: string[] = []): string[] {
  if (n == null) return out;
  if (typeof n === "string") {
    out.push(n);
    return out;
  }
  for (const c of n.children ?? []) texts(c, out);
  return out;
}

function render() {
  const answers: [string, string | undefined][] = [];
  let skipped = 0;
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      React.createElement(HowHeardView, {
        onAnswer: (v, d) => answers.push([v, d]),
        onSkip: () => void skipped++,
      }),
    );
  });
  const pressText = (label: string) => {
    const hit = r.root.findAll(
      (n) => typeof n.props.onPress === "function" && texts(n as unknown as Node).join("") === label,
    )[0] ?? r.root.findAll((n) => n.props.label === label && typeof n.props.onPress === "function")[0];
    assert.ok(hit, `no control "${label}"`);
    act(() => {
      (hit.props.onPress as () => void)();
    });
  };
  return { r, answers, skipped: () => skipped, pressText };
}

test("D view: the title, the eight answers and Skip; no 'who?' box until 'A creator'", () => {
  const { r } = render();
  const t = texts(r.toJSON() as Node).join(" | ");
  for (const s of [
    "How did you hear about Kiwi?",
    "Friend or family",
    "Instagram",
    "TikTok",
    "Reddit",
    "Google search",
    "App Store / Play Store search",
    "A creator",
    "Other",
    "Skip",
  ]) {
    assert.ok(t.includes(s), `missing "${s}": ${t}`);
  }
  assert.ok(!t.includes("Who? (optional)"), t);
});

test("D view: one tap answers", () => {
  const v = render();
  v.pressText("Reddit");
  assert.deepEqual(v.answers, [["reddit", undefined]]);
});

test("D view: 'A creator' opens the box; Continue sends what was typed", () => {
  const v = render();
  v.pressText("A creator");
  assert.deepEqual(v.answers, [], "the tap opens the box, it does not answer");
  assert.ok(texts(v.r.toJSON() as Node).join(" ").includes("Who? (optional)"));
  const input = v.r.root.findAll((n) => n.props.accessibilityLabel === "Which creator" && typeof n.props.onChangeText === "function")[0];
  act(() => {
    (input.props.onChangeText as (s: string) => void)("@kenji");
  });
  v.pressText("Continue");
  assert.deepEqual(v.answers, [["creator", "@kenji"]]);
});

test("D view: Skip answers nothing", () => {
  const v = render();
  v.pressText("Skip");
  assert.equal(v.skipped(), 1);
  assert.deepEqual(v.answers, []);
});
