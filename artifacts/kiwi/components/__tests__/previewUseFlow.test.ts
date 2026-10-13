// PREVIEW-1 B — the preview "use" flow (components/planPreview/previewUseFlow.ts)
// that both onUsePlan callers delegate to. The rule under test: once the
// create succeeds, the plan is never created again.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVATE_FAILED_NOTICE,
  runUseFromPreview,
  type UseFromPreviewDeps,
} from "../planPreview/previewUseFlow";

function fakes(over: { createFails?: boolean; activateFails?: boolean } = {}) {
  const log = {
    creates: [] as string[],
    activates: [] as string[],
    opened: [] as string[],
    notices: [] as string[],
  };
  let n = 0;
  const deps: UseFromPreviewDeps = {
    createFromTemplate: async (templateId) => {
      log.creates.push(templateId);
      if (over.createFails) throw new Error("create failed");
      n += 1;
      return { instanceId: `inst-${n}` };
    },
    activateThisWeek: async (instanceId) => {
      log.activates.push(instanceId);
      if (over.activateFails) throw new Error("activate failed");
      return { demoted: null };
    },
    openPlan: (id) => {
      log.opened.push(id);
    },
    notify: (message) => {
      log.notices.push(message);
    },
  };
  return { deps, log };
}

test("create succeeds, activate fails: one create, the plan opens, the notice shows, and nothing throws", async () => {
  const { deps, log } = fakes({ activateFails: true });
  await runUseFromPreview(deps, "tmpl-1", { activate: true }); // resolves — no throw back to the sheet
  assert.deepEqual(log.creates, ["tmpl-1"], "exactly one create");
  assert.deepEqual(log.activates, ["inst-1"]);
  assert.deepEqual(log.opened, ["inst-1"], "navigates to the plan that was created");
  assert.deepEqual(log.notices, [ACTIVATE_FAILED_NOTICE]);
  assert.equal(ACTIVATE_FAILED_NOTICE, "Couldn't set this week's plan. Please try again.");
});

test("create fails: the error reaches the sheet; nothing is activated, opened or announced", async () => {
  const { deps, log } = fakes({ createFails: true });
  await assert.rejects(runUseFromPreview(deps, "tmpl-1", { activate: true }), /create failed/);
  assert.deepEqual(log.creates, ["tmpl-1"]);
  assert.deepEqual(log.activates, []);
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.notices, []);
});

test("happy path: create, activate, open; no notice", async () => {
  const { deps, log } = fakes();
  await runUseFromPreview(deps, "tmpl-1", { activate: true });
  assert.deepEqual(log, { creates: ["tmpl-1"], activates: ["inst-1"], opened: ["inst-1"], notices: [] });
});

test("Save for Later never activates", async () => {
  const { deps, log } = fakes({ activateFails: true });
  await runUseFromPreview(deps, "tmpl-1", { activate: false });
  assert.deepEqual(log, { creates: ["tmpl-1"], activates: [], opened: ["inst-1"], notices: [] });
});
