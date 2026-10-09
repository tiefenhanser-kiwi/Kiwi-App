// R3-0 — prisma/seedPrompts.ts runs the prompt seed, then the settings seed,
// and touches nothing else. The real seeders run against a recording stub that
// keeps just enough state to model the diff-driven version bump.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { seedPromptsAndSettings } from "../../../prisma/seedPrompts";

type Version = { id: string; promptId: string; version: number; body: string; isActive: boolean };

function recordingPrisma(settings: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const prompts = new Map<string, { id: string; defaultModel: string }>();
  const versions: Version[] = [];
  const settingValues = new Map<string, unknown>(Object.entries(settings));
  const rec = (name: string) => calls.push(name);

  const models = {
    aIPrompt: {
      upsert: async (a: { where: { key: string }; create: { defaultModel: string } }) => {
        rec("aIPrompt.upsert");
        const row = prompts.get(a.where.key) ?? { id: `p-${a.where.key}`, defaultModel: "" };
        row.defaultModel = a.create.defaultModel;
        prompts.set(a.where.key, row);
        return { id: row.id };
      },
      deleteMany: async () => { rec("aIPrompt.deleteMany"); return { count: 0 }; },
    },
    aIPromptVersion: {
      findFirst: async (a: { where: { promptId: string } }) => {
        rec("aIPromptVersion.findFirst");
        return versions.find((v) => v.promptId === a.where.promptId && v.isActive) ?? null;
      },
      aggregate: async (a: { where: { promptId: string } }) => {
        rec("aIPromptVersion.aggregate");
        const mine = versions.filter((v) => v.promptId === a.where.promptId);
        return { _max: { version: mine.length ? Math.max(...mine.map((v) => v.version)) : null } };
      },
      // Called to BUILD the $transaction array; the stub applies on build.
      updateMany: (a: { where: { promptId: string } }) => {
        rec("aIPromptVersion.updateMany");
        for (const v of versions) if (v.promptId === a.where.promptId) v.isActive = false;
        return Promise.resolve({ count: 1 });
      },
      create: (a: { data: Omit<Version, "id"> }) => {
        rec("aIPromptVersion.create");
        versions.push({ ...a.data, id: `v${versions.length}` });
        return Promise.resolve({});
      },
    },
    systemSetting: {
      // Applies whichever branch the seeder wrote, as Prisma would: the test
      // below pins the seeder's `update`, not this stub.
      upsert: async (a: { where: { key: string }; create: { value: unknown }; update: { value?: unknown } }) => {
        rec("systemSetting.upsert");
        if (!settingValues.has(a.where.key)) settingValues.set(a.where.key, a.create.value);
        else if ("value" in a.update) settingValues.set(a.where.key, a.update.value);
        return {};
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => { rec("$transaction"); return Promise.all(ops); },
  };

  // Any model or method the seeders were not expected to touch is recorded and
  // then fails the run, so "nothing else" is asserted rather than assumed.
  const strict = (path: string, target: Record<string, unknown>): unknown =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop in t) {
          const v = t[prop];
          return typeof v === "object" && v !== null ? strict(`${path}${prop}.`, v as Record<string, unknown>) : v;
        }
        calls.push(`UNEXPECTED ${path}${prop}`);
        throw new Error(`seedPrompts touched ${path}${prop}`);
      },
    });

  return { client: strict("", models) as unknown as PrismaClient, calls, prompts, versions, settingValues };
}

const silently = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

describe("seedPromptsAndSettings", () => {
  it("runs the prompt seed, then the settings seed, and touches no other model", async () => {
    const db = recordingPrisma();
    await silently(() => seedPromptsAndSettings(db.client));

    assert.ok(!db.calls.some((c) => c.startsWith("UNEXPECTED")), db.calls.filter((c) => c.startsWith("UNEXPECTED")).join(", "));
    const models = new Set(db.calls.map((c) => c.split(".")[0]));
    assert.deepEqual([...models].sort(), ["$transaction", "aIPrompt", "aIPromptVersion", "systemSetting"]);

    const lastPrompt = Math.max(...db.calls.map((c, i) => (c.startsWith("aIPrompt") ? i : -1)));
    const firstSetting = db.calls.indexOf("systemSetting.upsert");
    assert.ok(firstSetting > lastPrompt, "every prompt write precedes the first settings write");
  });

  it("a body byte-identical to the active version makes no new version", async () => {
    const db = recordingPrisma();
    await silently(() => seedPromptsAndSettings(db.client));
    const after1 = db.versions.length;
    assert.ok(after1 > 0);

    await silently(() => seedPromptsAndSettings(db.client));
    assert.equal(db.versions.length, after1, "second run bumps nothing");

    // One body differs by one byte → exactly that key bumps, once.
    const target = db.versions.find((v) => v.promptId === "p-prep.narrate_steps" && v.isActive)!;
    target.body += " ";
    await silently(() => seedPromptsAndSettings(db.client));
    assert.equal(db.versions.length, after1 + 1);
    const active = db.versions.filter((v) => v.promptId === "p-prep.narrate_steps" && v.isActive);
    assert.equal(active.length, 1);
    assert.equal(active[0].version, 2);
  });

  it("prep.narrate_steps seeds with claude-sonnet-5-5", async () => {
    const db = recordingPrisma();
    await silently(() => seedPromptsAndSettings(db.client));
    assert.equal(db.prompts.get("prep.narrate_steps")?.defaultModel, "claude-sonnet-5-5");
  });

  it("an operator switch already set by hand keeps its value", async () => {
    const db = recordingPrisma({ "retailer.instacart_enabled": true, "wizard.candidate_count": 5 });
    await silently(() => seedPromptsAndSettings(db.client));
    assert.equal(db.settingValues.get("retailer.instacart_enabled"), true);
    assert.equal(db.settingValues.get("wizard.candidate_count"), 5);
  });
});
