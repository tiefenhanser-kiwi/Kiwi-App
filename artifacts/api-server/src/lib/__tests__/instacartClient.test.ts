// Row 8 · Block 1 — the Instacart client (R9) and its env/boot plumbing (R8).
// Every fetch here is a fake; nothing reaches a network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createShoppingListLink,
  InstacartApiError,
  InstacartTimeoutError,
  logInstacartConfig,
  missingInstacartEnv,
  readInstacartConfig,
  type InstacartConfig,
} from "../retailers/instacartClient";
import type { InstacartShoppingListPayload } from "../retailers/instacartPayload";

const KEY = "keys.test-secret-value-never-logged";
const CONFIG: InstacartConfig = { apiKey: KEY, baseUrl: "https://connect.dev.example" };

const PAYLOAD: InstacartShoppingListPayload = {
  title: "Kiwi grocery list",
  link_type: "shopping_list",
  expires_in: 30,
  line_items: [
    { name: "black beans", quantity: 2, unit: "can", display_text: "2 cans black beans" },
    { name: "cilantro", quantity: 1, unit: "bunch" },
  ],
};

interface Recorded {
  infos: Array<{ obj: Record<string, unknown>; msg: string }>;
  warns: Array<{ obj: Record<string, unknown>; msg: string }>;
}
function recorder(): Recorded & {
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
} {
  const infos: Recorded["infos"] = [];
  const warns: Recorded["warns"] = [];
  return {
    infos,
    warns,
    log: {
      info: (obj, msg) => infos.push({ obj, msg }),
      warn: (obj, msg) => warns.push({ obj, msg }),
    },
  };
}

function fakeFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  calls: Array<{ url: string; init: RequestInit }> = [],
): { fetch: typeof fetch; calls: typeof calls } {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("env + boot (R8)", () => {
  it("names the missing variables, never a value", () => {
    assert.deepEqual(missingInstacartEnv({}), ["INSTACART_API_KEY", "INSTACART_API_BASE_URL"]);
    assert.deepEqual(missingInstacartEnv({ INSTACART_API_KEY: KEY }), ["INSTACART_API_BASE_URL"]);
    assert.deepEqual(missingInstacartEnv({ INSTACART_API_KEY: "  ", INSTACART_API_BASE_URL: "x" }), [
      "INSTACART_API_KEY",
    ]);
    assert.equal(readInstacartConfig({}), null);
  });

  it("reads the config and drops a trailing slash on the host", () => {
    assert.deepEqual(
      readInstacartConfig({ INSTACART_API_KEY: ` ${KEY} `, INSTACART_API_BASE_URL: "https://h.example/" }),
      { apiKey: KEY, baseUrl: "https://h.example" },
    );
  });

  it("the boot line says configured and carries the host origin only", () => {
    const r = recorder();
    const report = logInstacartConfig(
      { INSTACART_API_KEY: KEY, INSTACART_API_BASE_URL: "https://connect.dev.example/idp" },
      r.log,
    );
    assert.deepEqual(report, { configured: true, missing: [] });
    assert.equal(r.infos.length, 1);
    assert.equal(r.infos[0]!.msg, "instacart: configured (https://connect.dev.example)");
    assert.deepEqual(Object.keys(r.infos[0]!.obj).sort(), ["configured", "event", "host", "missing"]);
  });

  it("the boot line says not configured with the NAMES that are missing", () => {
    const r = recorder();
    const report = logInstacartConfig({}, r.log);
    assert.deepEqual(report, { configured: false, missing: ["INSTACART_API_KEY", "INSTACART_API_BASE_URL"] });
    assert.equal(
      r.infos[0]!.msg,
      "instacart: not configured (missing INSTACART_API_KEY, INSTACART_API_BASE_URL)",
    );
  });

  it("the key's VALUE never appears in the boot summary (da8969b hygiene, extended)", () => {
    const r = recorder();
    logInstacartConfig(
      { INSTACART_API_KEY: KEY, INSTACART_API_BASE_URL: "https://h.example", DATABASE_URL: "postgres://secret" },
      r.log,
    );
    const serialized = JSON.stringify(r.infos) + JSON.stringify(r.warns);
    assert.ok(!serialized.includes(KEY), "INSTACART_API_KEY leaked into the boot line");
    assert.ok(!serialized.includes("postgres://"), "DATABASE_URL leaked");
  });
});

describe("createShoppingListLink (R9)", () => {
  it("POSTs the payload with the bearer key and returns the URL", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(JSON.stringify({ products_link_url: "https://www.instacart.com/store/shopping_lists/1?x=1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const r = recorder();
    const result = await createShoppingListLink(PAYLOAD, { config: CONFIG, fetch, log: r.log });
    assert.deepEqual(result, { url: "https://www.instacart.com/store/shopping_lists/1?x=1" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://connect.dev.example/idp/v1/products/products_link");
    assert.equal(calls[0]!.init.method, "POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.accept, "application/json");
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), PAYLOAD);
    assert.ok(calls[0]!.init.signal instanceof AbortSignal, "an AbortSignal rides the request");

    // One structured line, never the key, never the returned URL.
    assert.equal(r.infos.length, 1);
    assert.equal(r.warns.length, 0);
    const line = r.infos[0]!;
    assert.equal(line.obj.event, "instacart_products_link");
    assert.equal(line.obj.retailer, "instacart");
    assert.equal(line.obj.status, 200);
    assert.equal(line.obj.itemCount, 2);
    assert.equal(line.obj.endpoint, "https://connect.dev.example/idp/v1/products/products_link");
    assert.equal(typeof line.obj.latencyMs, "number");
    const serialized = JSON.stringify(r.infos);
    assert.ok(!serialized.includes(KEY), "key leaked into the call log");
    assert.ok(!serialized.includes("shopping_lists/1"), "returned URL leaked into the call log");
  });

  it("a non-2xx throws InstacartApiError with status and a ≤300-char excerpt", async () => {
    const longBody = JSON.stringify({ error: "x".repeat(1000) });
    const { fetch } = fakeFetch(() => new Response(longBody, { status: 422 }));
    const r = recorder();
    await assert.rejects(
      () => createShoppingListLink(PAYLOAD, { config: CONFIG, fetch, log: r.log }),
      (err: unknown) => {
        assert.ok(err instanceof InstacartApiError);
        assert.equal(err.status, 422);
        assert.ok(err.bodyExcerpt.length <= 301, `excerpt is ${err.bodyExcerpt.length} chars`);
        assert.ok(err.bodyExcerpt.endsWith("…"));
        return true;
      },
    );
    assert.equal(r.warns.length, 1);
    assert.equal(r.warns[0]!.obj.status, 422);
    assert.ok(!JSON.stringify(r.warns).includes(KEY), "key leaked into the failure log");
  });

  it("a 2xx without products_link_url is an InstacartApiError, not a success", async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await assert.rejects(
      () => createShoppingListLink(PAYLOAD, { config: CONFIG, fetch, log: recorder().log }),
      (err: unknown) => err instanceof InstacartApiError && err.status === 200,
    );
    const { fetch: notJson } = fakeFetch(() => new Response("<html>", { status: 200 }));
    await assert.rejects(
      () => createShoppingListLink(PAYLOAD, { config: CONFIG, fetch: notJson, log: recorder().log }),
      (err: unknown) => err instanceof InstacartApiError && err.bodyExcerpt.startsWith("non-JSON"),
    );
  });

  it("a network failure is an InstacartApiError with status 0", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    await assert.rejects(
      () => createShoppingListLink(PAYLOAD, { config: CONFIG, fetch, log: recorder().log }),
      (err: unknown) => err instanceof InstacartApiError && err.status === 0,
    );
  });

  it("the deadline aborts the request and throws InstacartTimeoutError", async () => {
    const { fetch } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const r = recorder();
    await assert.rejects(
      () => createShoppingListLink(PAYLOAD, { config: CONFIG, fetch, timeoutMs: 20, log: r.log }),
      (err: unknown) => err instanceof InstacartTimeoutError && err.timeoutMs === 20,
    );
    assert.equal(r.warns.length, 1);
    assert.equal(r.warns[0]!.obj.status, 0);
  });
});
