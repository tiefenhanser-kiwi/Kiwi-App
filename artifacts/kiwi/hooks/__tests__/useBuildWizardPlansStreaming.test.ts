// Latency Block (D-WS9-076) — useBuildWizardPlansStreaming hook tests.
// Mounts a Probe that captures the hook value, drives mutate()/reset() through
// the tree, and injects fake stream/buffered impls (no network).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  useBuildWizardPlansStreaming,
  type BuildWizardPlansStreamingResult,
  type UseBuildWizardPlansStreamingDeps,
} from "../useBuildWizardPlansStreaming";
import { UpgradeRequiredError } from "@/lib/api/errors";
import type {
  WizardPlanCandidate,
  WizardPreferencesInput,
} from "@/lib/types";

const INPUT = {} as WizardPreferencesInput;

function candidate(id: string): WizardPlanCandidate {
  return {
    id,
    title: `Plan ${id}`,
    tags: ["Easy"],
    whyBullets: ["Balanced"],
    mealTitles: ["A", "B", "C"],
    dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
  } as WizardPlanCandidate;
}

function mount(deps: UseBuildWizardPlansStreamingDeps) {
  let captured: BuildWizardPlansStreamingResult | null = null;
  function Probe(): null {
    captured = useBuildWizardPlansStreaming(deps);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  return { renderer, latest: () => captured! };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("accumulates candidates progressively, then resolves success", async () => {
  const streamImpl: UseBuildWizardPlansStreamingDeps["streamImpl"] = async (
    _input,
    onCandidate,
  ) => {
    onCandidate(0, candidate("c0"));
    onCandidate(1, candidate("c1"));
    onCandidate(2, candidate("c2"));
    return { cannotGenerateMore: false };
  };
  const bufferedImpl = async () => {
    throw new Error("buffered should not be called");
  };
  const { renderer, latest } = mount({ streamImpl, bufferedImpl });

  await act(async () => {
    latest().mutate(INPUT);
    await flush();
  });

  const v = latest();
  assert.equal(v.isSuccess, true);
  assert.equal(v.isPending, false);
  assert.equal(v.data?.candidates.length, 3);
  assert.deepEqual(
    v.data?.candidates.map((c) => c.id),
    ["c0", "c1", "c2"],
  );
  renderer.unmount();
});

test("falls back to buffered when the stream fails with zero candidates", async () => {
  let bufferedCalls = 0;
  const streamImpl: UseBuildWizardPlansStreamingDeps["streamImpl"] = async () => {
    throw new Error("stream boom");
  };
  const bufferedImpl = async () => {
    bufferedCalls++;
    return {
      candidates: [candidate("b0"), candidate("b1"), candidate("b2")],
      cannotGenerateMore: false,
    };
  };
  const { renderer, latest } = mount({ streamImpl, bufferedImpl });

  await act(async () => {
    latest().mutate(INPUT);
    await flush();
  });

  const v = latest();
  assert.equal(bufferedCalls, 1);
  assert.equal(v.isSuccess, true);
  assert.equal(v.isError, false);
  assert.deepEqual(
    v.data?.candidates.map((c) => c.id),
    ["b0", "b1", "b2"],
  );
  renderer.unmount();
});

test("keeps already-streamed cards when the stream dies mid-flight (no fallback)", async () => {
  let bufferedCalls = 0;
  const streamImpl: UseBuildWizardPlansStreamingDeps["streamImpl"] = async (
    _input,
    onCandidate,
  ) => {
    onCandidate(0, candidate("c0"));
    throw new Error("died after one card");
  };
  const bufferedImpl = async () => {
    bufferedCalls++;
    return { candidates: [], cannotGenerateMore: false };
  };
  const { renderer, latest } = mount({ streamImpl, bufferedImpl });

  await act(async () => {
    latest().mutate(INPUT);
    await flush();
  });

  const v = latest();
  assert.equal(bufferedCalls, 0, "must not fall back when cards already arrived");
  assert.equal(v.isSuccess, true);
  assert.equal(v.data?.candidates.length, 1);
  renderer.unmount();
});

test("surfaces UpgradeRequiredError without falling back", async () => {
  let bufferedCalls = 0;
  const streamImpl: UseBuildWizardPlansStreamingDeps["streamImpl"] = async () => {
    throw new UpgradeRequiredError({ status: 402, body: null });
  };
  const bufferedImpl = async () => {
    bufferedCalls++;
    return { candidates: [], cannotGenerateMore: false };
  };
  const { renderer, latest } = mount({ streamImpl, bufferedImpl });

  await act(async () => {
    latest().mutate(INPUT);
    await flush();
  });

  const v = latest();
  assert.equal(bufferedCalls, 0);
  assert.equal(v.isError, true);
  assert.ok(v.error instanceof UpgradeRequiredError);
  renderer.unmount();
});

test("a stale run's late candidate cannot clobber a newer run (tap/re-roll safety)", async () => {
  // First run resolves its onCandidate LATE (after we start a second run). The
  // generation guard must ignore the stale callback.
  let firstEmit: (() => void) | null = null;
  let call = 0;
  const streamImpl: UseBuildWizardPlansStreamingDeps["streamImpl"] = async (
    _input,
    onCandidate,
  ) => {
    call++;
    if (call === 1) {
      // defer the first run's candidate until we release it
      await new Promise<void>((resolve) => {
        firstEmit = () => {
          onCandidate(0, candidate("STALE"));
          resolve();
        };
      });
      return { cannotGenerateMore: false };
    }
    onCandidate(0, candidate("FRESH"));
    return { cannotGenerateMore: false };
  };
  const bufferedImpl = async () => ({
    candidates: [],
    cannotGenerateMore: false,
  });
  const { renderer, latest } = mount({ streamImpl, bufferedImpl });

  // Start run 1 (hangs), then reset + start run 2 (resolves FRESH).
  await act(async () => {
    latest().mutate(INPUT);
    await flush();
  });
  await act(async () => {
    latest().reset();
    latest().mutate(INPUT);
    await flush();
  });
  // Now release run 1's stale candidate — it must be ignored.
  await act(async () => {
    firstEmit?.();
    await flush();
  });

  const v = latest();
  assert.deepEqual(
    v.data?.candidates.map((c) => c.id),
    ["FRESH"],
    "stale run's candidate must not appear",
  );
  renderer.unmount();
});

test("reset() returns the hook to idle", async () => {
  const streamImpl: UseBuildWizardPlansStreamingDeps["streamImpl"] = async (
    _i,
    onCandidate,
  ) => {
    onCandidate(0, candidate("c0"));
    return { cannotGenerateMore: false };
  };
  const bufferedImpl = async () => ({ candidates: [], cannotGenerateMore: false });
  const { renderer, latest } = mount({ streamImpl, bufferedImpl });

  await act(async () => {
    latest().mutate(INPUT);
    await flush();
  });
  assert.equal(latest().isSuccess, true);

  await act(async () => {
    latest().reset();
    await flush();
  });
  const v = latest();
  assert.equal(v.isSuccess, false);
  assert.equal(v.isPending, false);
  assert.equal(v.data, undefined);
  renderer.unmount();
});
