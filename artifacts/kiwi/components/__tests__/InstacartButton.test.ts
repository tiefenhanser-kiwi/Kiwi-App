// Row 8 Block 2 — InstacartButton, the compliance CTA.
//
// What this file pins is the EXTERNAL spec (Instacart's CTA-design page, Dark
// theme, read September 19, 2026): the exact label string, 46 px height, 22 px
// logo, 18 px horizontal padding, the pill radius, and the two colours. A
// "tidy" that moves any of these fails the production-key review, not a
// design taste.
//
// And the logo asset. The component `require()`s the official mark from
// assets/instacart/. The require is shimmed here the way HomeHeader.test.ts
// shims its header mark (node:test has no asset loader) and the SPECIFIER it
// records is resolved against the components dir on disk — so the test fails
// when the file the component actually points at is not in the repo, and a
// missing logo cannot ship silently. It also checks the file is a real svg
// root (Metro runs image-size on every .svg asset at bundle time; a text
// README saved under that name would break every dev build).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const LOGO_ASSET_ID = 2626;
const requiredSpecifiers: string[] = [];
(globalThis as { require?: unknown }).require = (specifier: string) => {
  requiredSpecifiers.push(specifier);
  return LOGO_ASSET_ID;
};

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  INSTACART_CTA,
  INSTACART_CTA_LABEL,
  InstacartButton,
} from "../InstacartButton";

after(() => {
  delete (globalThis as { require?: unknown }).require;
});

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function findAll(node: Node | string | null, type: string, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAll(c, type, out);
  }
  return out;
}

function gatherText(node: Node | string | null, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) for (const c of node.children) gatherText(c, out);
  return out;
}

function flatten(style: unknown): Record<string, unknown> {
  const parts = Array.isArray(style) ? style.flat(Infinity) : [style];
  return Object.assign({}, ...parts.filter(Boolean));
}

function render(props: React.ComponentProps<typeof InstacartButton>): Node {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(InstacartButton, props));
  });
  return tree.toJSON() as unknown as Node;
}

function rootStyle(node: Node, pressed = false): Record<string, unknown> {
  const s = node.props?.style as (a: { pressed: boolean }) => unknown;
  assert.equal(typeof s, "function");
  return flatten(s({ pressed }));
}

const COMPONENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the referenced logo asset exists in the repo and is an svg root", () => {
  render({});
  const spec = requiredSpecifiers.find((s) => /instacart-logo\.(svg|png)$/.test(s));
  assert.ok(spec, `expected a require of instacart-logo.svg/.png, saw: ${JSON.stringify(requiredSpecifiers)}`);
  const abs = path.resolve(COMPONENTS_DIR, spec);
  assert.ok(existsSync(abs), `logo asset missing at ${abs} — the CTA must not ship without the official mark`);
  if (abs.endsWith(".svg")) {
    const body = readFileSync(abs, "utf8");
    assert.match(body, /<svg[\s>]/, "the .svg asset must be a real svg document (Metro runs image-size on it)");
    // Row 8 Block 3 — image-size (1.2.1, what Metro runs) sizes an svg from
    // width/height attributes OR, when absent, from viewBox. Instacart's
    // official file is viewBox-only ("0 0 42.3 52.9" → 42×53), so Block 2's
    // `width="\d+"` assertion over-claimed the requirement and went red on the
    // real mark. Either is enough for the bundle to build.
    assert.match(
      body,
      /\s(?:width=['"][0-9.]+(?:px)?['"]|viewBox=['"][0-9.\s-]+['"])/,
      "the svg root must be sizable (width attr or viewBox — image-size reads either)",
    );
  }
});

test("label is exactly the permitted string and nothing else is painted", () => {
  const tree = render({});
  assert.deepEqual(gatherText(tree), ["Shop on Instacart"]);
  assert.equal(INSTACART_CTA_LABEL, "Shop on Instacart");
});

test("Dark theme geometry and colours, verbatim from the CTA-design page", () => {
  const tree = render({});
  const st = rootStyle(tree);
  assert.equal(st.height, 46);
  assert.equal(st.paddingHorizontal, 18);
  assert.equal(st.borderRadius, 23, "pill: half the 46 px height");
  assert.equal(st.backgroundColor, "#003D29");
  assert.equal(st.paddingVertical, undefined, "vertical inset is centring, not padding (46 − 22 leaves no room for 16)");
  const label = findAll(tree, "rn-text")[0];
  assert.equal(flatten(label.props?.style).color, "#FAF1E5");
  const logo = findAll(tree, "expo-image")[0];
  assert.ok(logo, "the mark renders through expo-image");
  const ls = flatten(logo.props?.style);
  assert.equal(ls.width, 22);
  assert.equal(ls.height, 22);
  assert.equal(logo.props?.source, LOGO_ASSET_ID);
  assert.deepEqual(INSTACART_CTA, {
    height: 46,
    logo: 22,
    paddingHorizontal: 18,
    radius: 23,
    background: "#003D29",
    label: "#FAF1E5",
  });
});

test("no Kiwi mark, no 'powered by', no second image", () => {
  const tree = render({});
  assert.equal(findAll(tree, "expo-image").length, 1);
  assert.equal(findAll(tree, "rn-image").length, 0);
  const text = gatherText(tree).join(" ").toLowerCase();
  assert.ok(!text.includes("powered"), text);
  assert.ok(!text.includes("kiwi"), text);
  assert.ok(!text.includes("partner"), text);
});

test("disabled: onPress is detached and the pill dims", () => {
  let calls = 0;
  const tree = render({ disabled: true, onPress: () => void calls++ });
  assert.equal(tree.props?.onPress, undefined);
  assert.equal(tree.props?.disabled, true);
  assert.equal(rootStyle(tree).opacity, 0.5);
  assert.equal(rootStyle(tree, true).opacity, 0.5, "pressed does not override the disabled dim");
  assert.equal(calls, 0);
});

test("loading: a spinner replaces the label and the press is inert", () => {
  const tree = render({ loading: true, onPress: () => {} });
  assert.equal(findAll(tree, "rn-activity-indicator").length, 1);
  assert.deepEqual(gatherText(tree), []);
  assert.equal(tree.props?.onPress, undefined);
  assert.deepEqual(tree.props?.accessibilityState, { disabled: true, busy: true });
  assert.equal(rootStyle(tree).height, 46, "the box does not collapse while loading");
});

test("enabled: press fires once; testID and a11y label pass through", () => {
  let calls = 0;
  const tree = render({ onPress: () => void calls++, testID: "instacart-cta" });
  (tree.props?.onPress as () => void)();
  assert.equal(calls, 1);
  assert.equal(tree.props?.testID, "instacart-cta");
  assert.equal(tree.props?.accessibilityRole, "button");
  assert.equal(tree.props?.accessibilityLabel, "Shop on Instacart");
});
