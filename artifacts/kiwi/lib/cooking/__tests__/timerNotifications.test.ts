// D-WS9-289 — the timer-notification POLICY. Every rule the ruling states, and
// the two platform branches, pinned here rather than on a device.
//
// No expo-notifications anywhere in this file's module graph: the notifications
// module is an interface and this recorder implements it, which is the whole
// reason the seam exists.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTimerNotifier,
  type NotificationsModule,
  type TimerPlatform,
} from "../timerNotifications";

type Call =
  | { kind: "getPermissions" }
  | { kind: "requestPermissions" }
  | { kind: "setHandler" }
  | { kind: "schedule"; label: string; endsAtMs: number; id: string }
  | { kind: "cancel"; id: string };

function recorder(opts: {
  /** what getPermissionsAsync reports (pre-existing grant, or not) */
  existing?: string;
  /** what the user answers to the prompt */
  answer?: string;
} = {}) {
  const calls: Call[] = [];
  let n = 0;
  const notifications: NotificationsModule = {
    async getPermissionsAsync() {
      calls.push({ kind: "getPermissions" });
      return { status: opts.existing ?? "undetermined" };
    },
    async requestPermissionsAsync() {
      calls.push({ kind: "requestPermissions" });
      return { status: opts.answer ?? "granted" };
    },
    async scheduleNotificationAsync(request) {
      const r = request as { label: string; endsAtMs: number };
      const id = `notif-${++n}`;
      calls.push({ kind: "schedule", label: r.label, endsAtMs: r.endsAtMs, id });
      return id;
    },
    async cancelScheduledNotificationAsync(id) {
      calls.push({ kind: "cancel", id });
    },
    setNotificationHandler() {
      calls.push({ kind: "setHandler" });
    },
  };
  return { calls, notifications };
}

function notifier(
  platform: TimerPlatform,
  opts: Parameters<typeof recorder>[0] = {},
) {
  const rec = recorder(opts);
  const n = createTimerNotifier({
    platform,
    notifications: rec.notifications,
    // The recorder's scheduleNotificationAsync reads these straight back, so the
    // assertions can see WHAT was scheduled without duplicating the live payload.
    buildRequest: ({ label, endsAtMs }) => ({ label, endsAtMs }),
    handler: { marker: "foreground-handler" },
  });
  return { ...rec, n };
}

const kinds = (calls: Call[]) => calls.map((c) => c.kind);

describe("D-WS9-289 — timer notifications, iOS", () => {
  it("asks for permission at the FIRST timer start, and only once", async () => {
    const { n, calls } = notifier("ios");
    await n.schedule("step-1", "Sear the steak", 1_000);
    assert.deepEqual(kinds(calls), [
      "getPermissions",
      "requestPermissions",
      "setHandler",
      "schedule",
    ]);

    // A second start must NOT re-ask.
    await n.schedule("step-2", "Rest the steak", 2_000);
    assert.deepEqual(kinds(calls).slice(4), ["schedule"]);
    assert.equal(n.permissionState(), "granted");
  });

  it("an existing grant from a previous session never prompts", async () => {
    const { n, calls } = notifier("ios", { existing: "granted" });
    await n.schedule("step-1", "Boil", 1_000);
    assert.deepEqual(kinds(calls), ["getPermissions", "setHandler", "schedule"]);
    assert.ok(
      !kinds(calls).includes("requestPermissions"),
      "must not prompt when permission is already held",
    );
  });

  it("a DENIAL falls back silently and is not re-asked this session", async () => {
    const { n, calls } = notifier("ios", { answer: "denied" });
    await n.schedule("step-1", "Simmer", 1_000);
    assert.deepEqual(kinds(calls), ["getPermissions", "requestPermissions"]);
    assert.equal(n.permissionState(), "denied");

    // Two more starts and a cancel: nothing further reaches the OS. A permission
    // sheet that reappears on every timer is what gets an app uninstalled.
    await n.schedule("step-2", "Reduce", 2_000);
    await n.schedule("step-3", "Glaze", 3_000);
    await n.cancel("step-1");
    assert.equal(calls.length, 2, "a denial must be terminal for the session");
    // And nothing was scheduled, so nothing is pending to leak.
    assert.deepEqual(n.pendingKeys(), []);
  });

  it("schedules at the timer's own end instant, announcing its label", async () => {
    const { n, calls } = notifier("ios", { existing: "granted" });
    await n.schedule("step-1", "Braise the short ribs", 1_700_000_000_000);
    const scheduled = calls.find((c) => c.kind === "schedule");
    assert.deepEqual(scheduled, {
      kind: "schedule",
      label: "Braise the short ribs",
      endsAtMs: 1_700_000_000_000,
      id: "notif-1",
    });
    assert.deepEqual(n.pendingKeys(), ["step-1"]);
  });

  it('"Add a minute" RESCHEDULES — cancel then schedule, never two pending', async () => {
    const { n, calls } = notifier("ios", { existing: "granted" });
    await n.schedule("step-1", "Sear", 1_000);
    await n.schedule("step-1", "Sear", 61_000); // the +1 min tap

    assert.deepEqual(kinds(calls), [
      "getPermissions",
      "setHandler",
      "schedule",
      "cancel",
      "schedule",
    ]);
    // The cancel targeted the FIRST id, and the survivor carries the new time.
    assert.deepEqual(
      calls.filter((c) => c.kind === "cancel"),
      [{ kind: "cancel", id: "notif-1" }],
    );
    const last = calls.at(-1);
    assert.equal(last?.kind === "schedule" && last.endsAtMs, 61_000);
    // ONE pending alert for the timer, not two.
    assert.deepEqual(n.pendingKeys(), ["step-1"]);
  });

  it("clearing the timer cancels its alert", async () => {
    const { n, calls } = notifier("ios", { existing: "granted" });
    await n.schedule("step-1", "Sear", 1_000);
    await n.cancel("step-1");
    assert.deepEqual(kinds(calls).slice(-1), ["cancel"]);
    assert.deepEqual(n.pendingKeys(), []);

    // A second cancel is a no-op, not a second OS call.
    const before = calls.length;
    await n.cancel("step-1");
    assert.equal(calls.length, before);
  });

  it("cancelling something never scheduled does NOT ask for permission", async () => {
    const { n, calls } = notifier("ios");
    await n.cancel("step-never-started");
    assert.deepEqual(calls, [], "a cancel must never surface a permission sheet");
    assert.equal(n.permissionState(), "unknown");
  });

  it("the foreground handler is set once, lazily, on the first real schedule", async () => {
    const { n, calls } = notifier("ios", { existing: "granted" });
    assert.deepEqual(calls, [], "nothing happens before a timer starts");
    await n.schedule("step-1", "Sear", 1_000);
    await n.schedule("step-2", "Rest", 2_000);
    assert.equal(
      calls.filter((c) => c.kind === "setHandler").length,
      1,
      "the handler is set exactly once per session",
    );
  });

  it("two rapid reschedules leave exactly one pending alert, not an orphan", async () => {
    // Both schedules are in flight at once — the "Add a minute" double-tap. The
    // loser's identifier must be cancelled rather than left pending with nothing
    // holding it.
    const { n, calls } = notifier("ios", { existing: "granted" });
    await Promise.all([
      n.schedule("step-1", "Sear", 1_000),
      n.schedule("step-1", "Sear", 61_000),
    ]);
    assert.deepEqual(n.pendingKeys(), ["step-1"]);
    const scheduled = calls.filter((c) => c.kind === "schedule").length;
    const cancelled = calls.filter((c) => c.kind === "cancel").length;
    assert.equal(scheduled - cancelled, 1, "exactly one alert survives");
  });
});

// ── The platform branch. This is the ruling, and it is the reason `platform` is
// an INPUT rather than a read of Platform.OS inside the module. ──────────────
describe("D-WS9-289 — Android and web schedule NOTHING and ask for NOTHING", () => {
  for (const platform of ["android", "web"] as const) {
    it(`${platform}: no permission call, no schedule, no cancel`, async () => {
      const { n, calls } = notifier(platform, { existing: "granted" });
      await n.schedule("step-1", "Sear the steak", 1_000);
      await n.schedule("step-1", "Sear the steak", 61_000);
      await n.cancel("step-1");

      assert.deepEqual(
        calls,
        [],
        // Android's inexact-alarm path is documented as firing "within one hour
        // of the supplied trigger time". A kitchen timer that can be an hour
        // late is worse than no notification, so the ruling is: nothing at all,
        // and no permission prompt for a feature we do not ship.
        `${platform} must not touch the notifications module`,
      );
      assert.equal(n.permissionState(), "denied");
      assert.deepEqual(n.pendingKeys(), []);
    });
  }
});
