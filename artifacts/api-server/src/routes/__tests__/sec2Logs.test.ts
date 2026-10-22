// SEC-2 #12 + #15 — what the REAL logger emits, read from a child process's
// stdout in the production JSON shape (fixtures/sec2LogFixture.ts says why).
//
// Each case first proves its log line FIRED (an absence assertion over a line
// that never ran would pass for the wrong reason), then that the line does not
// carry the thing it used to.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MARKERS } from "./fixtures/sec2LogFixture.markers";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "sec2LogFixture.ts");

describe("SEC-2 #12 + #15 — log lines carry no address, search text, URL path or guest id", () => {
  let lines: Array<Record<string, unknown>> = [];
  let raw = "";

  before(() => {
    raw = execFileSync(process.execPath, ["--import", "tsx", FIXTURE], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(raw, /SEC2_LOG_FIXTURE_DONE/, "the fixture ran to the end");
    lines = raw
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  });

  const line = (event: string) => lines.find((l) => l["event"] === event);

  it("/healthz logs no caller address and no x-forwarded-for", () => {
    assert.match(raw, /SEC2_HEALTHZ_STATUS 200/, "the request was served");
    assert.equal(line("bug223_proxy_probe"), undefined);
    assert.equal(raw.includes(MARKERS.xff), false);
  });

  it("a failed grocery lookup logs the term's length, not the term", () => {
    const l = line("grocery_item_lookup_failed");
    assert.ok(l, "the failure line fired");
    assert.equal(l["qLength"], MARKERS.groceryTerm.length);
    assert.equal(raw.includes(MARKERS.groceryTerm), false);
  });

  it("a refused import logs the host, not the path or query", () => {
    const l = lines.find((x) => x["msg"] === "import-url fetch failed");
    assert.ok(l, "the failure line fired");
    assert.equal(l["host"], "example.com:8080");
    assert.equal(raw.includes(MARKERS.importPath), false);
    assert.equal(raw.includes(MARKERS.importQuery), false);
  });

  it("a refused guest claim logs that a guest was involved, not which session", () => {
    const l = line("guest_claim_refused");
    assert.ok(l, "the refusal line fired");
    assert.equal(l["guest"], true);
    assert.equal(raw.includes(MARKERS.guestId), false);
  });
});
