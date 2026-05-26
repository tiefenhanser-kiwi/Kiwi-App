// WS7-4-B c7 — useTemplatePreview hook tests. Renders a tiny Probe component
// that exposes the hook's current value, then drives open()/close() through
// the React tree and asserts state transitions.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { useTemplatePreview, type UseTemplatePreviewResult } from "../useTemplatePreview";

function mountProbe(): {
  renderer: TestRenderer.ReactTestRenderer;
  latest: () => UseTemplatePreviewResult;
} {
  let captured: UseTemplatePreviewResult | null = null;
  function Probe(): null {
    captured = useTemplatePreview();
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  return { renderer, latest: () => captured! };
}

test("useTemplatePreview initial state is closed (visible=false, templateId=null)", () => {
  const { renderer, latest } = mountProbe();
  const v = latest();
  assert.equal(v.visible, false);
  assert.equal(v.templateId, null);
  assert.equal(typeof v.open, "function");
  assert.equal(typeof v.close, "function");
  renderer.unmount();
});

test("open(id) sets templateId and flips visible to true", () => {
  const { renderer, latest } = mountProbe();
  act(() => {
    latest().open("tmpl-42");
  });
  const v = latest();
  assert.equal(v.visible, true);
  assert.equal(v.templateId, "tmpl-42");
  renderer.unmount();
});

test("close() clears state — visible=false, templateId=null", () => {
  const { renderer, latest } = mountProbe();
  act(() => {
    latest().open("tmpl-1");
  });
  assert.equal(latest().templateId, "tmpl-1");
  act(() => {
    latest().close();
  });
  const v = latest();
  assert.equal(v.visible, false);
  assert.equal(v.templateId, null);
  renderer.unmount();
});
