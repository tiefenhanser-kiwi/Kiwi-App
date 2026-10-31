// SHOP-1 (D-WS9-325) — GET /stores: the registry ranked for the cook's state, behind
// the fail-closed `retailer.shop_your_store_enabled` flag, with storesVersion on every
// answer (routes/stores.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { SHOP_YOUR_STORE_STORES, STORES_VERSION } from "../../lib/retailers/stores";
import { createStoresRouter } from "../stores";
import { withSessionUser } from "./fixtures/sessionUserStub";

const U = "user-shop1";
const DISCLOSURE = "Kiwi may earn a commission from some store links.";

async function serve(flag: unknown) {
  const db = {
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (flag === "throw") throw new Error("db down");
        return where.key === "retailer.shop_your_store_enabled" && flag !== null ? { key: where.key, value: flag } : null;
      },
    },
  };
  const app = express();
  app.use(createStoresRouter({ prisma: withSessionUser(db) as never }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string, auth = true) => {
    const res = await fetch(`${base}${path}`, { headers: auth ? { Authorization: `Bearer ${signToken(U)}` } : {} });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function once(flag: unknown, path: string, auth = true) {
  const h = await serve(flag);
  try {
    return await h.get(path, auth);
  } finally {
    await h.close();
  }
}

describe("SHOP-1 — GET /stores", () => {
  it("members only: no token is a 401", async () => {
    assert.equal((await once(true, "/stores?state=MA", false)).status, 401);
  });

  it("off (no row, false, a bad value, a database error): enabled false, NO stores, the version and disclosure", async () => {
    for (const flag of [null, false, "nope", "throw"]) {
      const r = await once(flag, "/stores?state=MA");
      assert.equal(r.status, 200, `flag ${String(flag)}`);
      assert.deepEqual(r.body, { enabled: false, storesVersion: STORES_VERSION, state: "MA", stores: [], disclosure: DISCLOSURE }, `flag ${String(flag)}`);
    }
  });

  it("on, ?state=MA: the stores that serve Massachusetts, most stores there first", async () => {
    const r = await once(true, "/stores?state=MA");
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.state, "MA");
    assert.equal(r.body.storesVersion, STORES_VERSION);
    assert.deepEqual(r.body.stores.map((s: any) => [s.key, s.storeCount]), [
      ["stop_and_shop", 117], ["shaws", 55], ["target", 51], ["walmart", 48], ["whole_foods", 32],
      ["aldi", 25], ["star_market", 21], ["hannaford", 15], ["costco", 6], ["wegmans", 5],
    ]);
    assert.deepEqual(r.body.stores[0], {
      key: "stop_and_shop",
      name: "Stop & Shop",
      bannerGroup: "Ahold Delhaize USA",
      orderType: "own_online",
      siteUrl: "https://stopandshop.com/",
      signInUrl: "https://stopandshop.com/modal/login",
      cartUrl: "https://stopandshop.com/cart",
      urlsStatus: "checked",
      searchUrl: "https://stopandshop.com/product-search/{q}",
      searchUrlStatus: "checked",
      appUrl: null,
      webviewOk: true,
      affiliateProgram: "Stop & Shop (FlexOffers)",
      states: ["CT", "MA", "NJ", "NY", "RI"],
      storeCount: 117,
    });
  });

  it("the state is any case and trimmed", async () => {
    const r = await once(true, "/stores?state=%20ma%20");
    assert.equal(r.body.state, "MA");
    assert.equal(r.body.stores[0].key, "stop_and_shop");
  });

  it("no state: the national list, every store, most stores nationally first", async () => {
    for (const path of ["/stores", "/stores?state="]) {
      const r = await once(true, path);
      assert.equal(r.status, 200);
      assert.equal(r.body.state, null);
      assert.equal(r.body.stores.length, SHOP_YOUR_STORE_STORES.length);
      assert.deepEqual(r.body.stores.slice(0, 2).map((s: any) => s.key), ["walmart", "aldi"]);
      const walmart = SHOP_YOUR_STORE_STORES.find((s) => s.key === "walmart")!;
      const total = Object.values(walmart.storeCounts).reduce((a, n) => a + n!, 0);
      assert.equal(r.body.stores[0].storeCount, total);
    }
  });

  it("a state Kiwi does not know is a 400, flag on or off, never a silent national list", async () => {
    for (const flag of [true, false]) {
      for (const path of ["/stores?state=ZZ", "/stores?state=Massachusetts", "/stores?state=MA&state=NY"]) {
        const r = await once(flag, path);
        assert.equal(r.status, 400, `${path} flag ${flag}`);
        assert.equal(r.body.error, "invalid state");
      }
    }
  });
});
