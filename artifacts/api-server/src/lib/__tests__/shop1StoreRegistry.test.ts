// SHOP-1 (D-WS9-325) — the Shop Your Store registry's shape and its state ranking
// (lib/retailers/stores.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseUsState,
  SHOP_YOUR_STORE_STORES,
  storeCountIn,
  storeSearchUrl,
  storesForState,
  STORES_VERSION,
  storesVersionOf,
  US_STATES,
  type RetailerStore,
} from "../retailers/stores";

const STORES = SHOP_YOUR_STORE_STORES;
const keys = (list: readonly RetailerStore[]) => list.map((s) => s.key);
// The site's registrable domain: "www.shaws.com" → "shaws.com", "delivery.publix.com" → "publix.com".
const baseDomain = (url: string) => new URL(url).hostname.split(".").slice(-2).join(".");

describe("SHOP-1 — the registry's shape", () => {
  it("34 stores in Hans's order, unique snake_case keys", () => {
    assert.deepEqual(keys(STORES), [
      "whole_foods", "aldi",
      "stop_and_shop", "shaws", "star_market", "hannaford", "wegmans",
      "walmart", "target",
      "kroger", "ralphs", "fred_meyer", "king_soopers", "harris_teeter", "frys", "smiths", "qfc",
      "albertsons", "safeway", "vons", "jewel_osco", "acme",
      "publix", "heb", "meijer", "costco", "sams_club",
      "giant_food", "giant_company", "giant_eagle", "shoprite", "food_lion", "sprouts", "hy_vee",
    ]);
    assert.equal(new Set(keys(STORES)).size, STORES.length);
    for (const s of STORES) assert.match(s.key, /^[a-z][a-z_]*[a-z]$/, s.key);
  });

  it("every v0 key survives, so a stored defaultRetailer keeps passing", () => {
    for (const k of ["kroger", "aldi", "whole_foods", "walmart", "target", "costco", "publix", "heb", "wegmans", "safeway", "stop_and_shop"]) {
      assert.ok(STORES.some((s) => s.key === k), k);
    }
  });

  it("a store with no online ordering is not offered at all (D-WS9-325)", () => {
    for (const s of STORES) {
      assert.doesNotMatch(`${s.key} ${s.name}`, /trader|market.?basket|winco/i, s.key);
      assert.ok(s.orderType === "own_online" || s.orderType === "instacart", s.key);
    }
  });

  it("the Instacart storefronts are Aldi, Publix and Sprouts, and their cart is a drawer (cartUrl null)", () => {
    assert.deepEqual(keys(STORES.filter((s) => s.orderType === "instacart")), ["aldi", "publix", "sprouts"]);
    for (const s of STORES.filter((x) => x.orderType === "instacart")) assert.equal(s.cartUrl, null, s.key);
  });

  it("every URL is https on the store's own domain; a search template has exactly one {q}", () => {
    for (const s of STORES) {
      const home = baseDomain(s.siteUrl);
      for (const url of [s.siteUrl, s.signInUrl, s.cartUrl, s.searchUrl]) {
        if (url === null) continue;
        assert.ok(url.startsWith("https://"), `${s.key}: ${url}`);
        assert.equal(baseDomain(url), home, `${s.key}: ${url}`);
      }
      if (s.searchUrl !== null) assert.equal(s.searchUrl.split("{q}").length, 2, s.key);
      assert.equal(s.appUrl, null, s.key);
    }
  });

  it("a store whose pages were hidden by a bot wall never claims webviewOk; only Whole Foods is ruled out", () => {
    for (const s of STORES.filter((x) => x.urlsStatus === "unverified")) assert.equal(s.webviewOk, null, s.key);
    assert.deepEqual(keys(STORES.filter((s) => s.webviewOk === false)), ["whole_foods"]);
    assert.equal(STORES.find((s) => s.key === "wegmans")!.searchUrlStatus, "documented");
  });

  it("store counts: real US states, positive whole numbers, at least one state each, a source named", () => {
    const valid = new Set<string>(US_STATES);
    for (const s of STORES) {
      const entries = Object.entries(s.storeCounts);
      assert.ok(entries.length > 0, s.key);
      for (const [st, n] of entries) {
        assert.ok(valid.has(st), `${s.key}: ${st}`);
        assert.ok(Number.isInteger(n) && n! > 0, `${s.key} ${st}: ${n}`);
      }
      assert.ok(s.countsSource.length > 0, s.key);
    }
  });

  it("affiliateProgram is a name or null; the Kroger banners share one group", () => {
    for (const s of STORES) assert.ok(s.affiliateProgram === null || s.affiliateProgram.trim().length > 0, s.key);
    assert.deepEqual(
      keys(STORES.filter((s) => s.bannerGroup === "The Kroger Co.")),
      ["kroger", "ralphs", "fred_meyer", "king_soopers", "harris_teeter", "frys", "smiths", "qfc"],
    );
  });
});

describe("SHOP-1 — storesVersion", () => {
  it("12 hex, the registry's own hash, the same for an identical copy", () => {
    assert.match(STORES_VERSION, /^[0-9a-f]{12}$/);
    assert.equal(STORES_VERSION, storesVersionOf(STORES));
    assert.equal(storesVersionOf(structuredClone(STORES) as RetailerStore[]), STORES_VERSION);
  });

  it("moves when a count, a URL or the order moves", () => {
    const copy = structuredClone(STORES) as RetailerStore[];
    copy[0] = { ...copy[0]!, storeCounts: { ...copy[0]!.storeCounts, CA: 1 } };
    assert.notEqual(storesVersionOf(copy), STORES_VERSION);
    const url = structuredClone(STORES) as RetailerStore[];
    url[1] = { ...url[1]!, signInUrl: "https://www.aldi.us/signin" };
    assert.notEqual(storesVersionOf(url), STORES_VERSION);
    assert.notEqual(storesVersionOf([...STORES].reverse()), STORES_VERSION);
  });
});

describe("SHOP-1 — the ranking (storesForState)", () => {
  it("MA: only the stores that serve it, most stores there first", () => {
    const ma = storesForState("MA");
    assert.deepEqual(keys(ma), [
      "stop_and_shop", "shaws", "target", "walmart", "whole_foods", "aldi", "star_market", "hannaford", "costco", "wegmans",
    ]);
    assert.deepEqual(ma.map((s) => storeCountIn(s, "MA")), [117, 55, 51, 48, 32, 25, 21, 15, 6, 5]);
  });

  it("TX: Walmart, H-E-B, Kroger lead; Publix (no Texas stores) is absent", () => {
    const tx = keys(storesForState("TX"));
    assert.deepEqual(tx.slice(0, 3), ["walmart", "heb", "kroger"]);
    assert.ok(!tx.includes("publix"));
  });

  it("every state's list holds exactly the stores with a count there, never increasing", () => {
    for (const st of US_STATES) {
      const list = storesForState(st);
      assert.deepEqual(new Set(keys(list)), new Set(keys(STORES.filter((s) => (s.storeCounts[st] ?? 0) > 0))), st);
      for (let i = 1; i < list.length; i++) {
        assert.ok(storeCountIn(list[i - 1]!, st) >= storeCountIn(list[i]!, st), `${st} at ${i}`);
      }
    }
  });

  it("no state: every store, most stores nationally first", () => {
    const all = storesForState(null);
    assert.equal(all.length, STORES.length);
    assert.deepEqual(keys(all).slice(0, 4), ["walmart", "aldi", "target", "publix"]);
    for (let i = 1; i < all.length; i++) assert.ok(storeCountIn(all[i - 1]!, null) >= storeCountIn(all[i]!, null), `at ${i}`);
  });

  it("a tie keeps the registry's order", () => {
    const base = STORES[0]!;
    const make = (key: string, n: number): RetailerStore => ({ ...base, key, storeCounts: { MA: n } });
    const reg = [make("first", 3), make("second", 5), make("third", 3), make("fourth", 5)];
    assert.deepEqual(keys(storesForState("MA", reg)), ["second", "fourth", "first", "third"]);
    assert.deepEqual(keys(storesForState("NY", reg)), []);
  });
});

describe("SHOP-1 — parseUsState and storeSearchUrl", () => {
  it("a two-letter code, any case, trimmed; anything else is undefined", () => {
    assert.equal(parseUsState("MA"), "MA");
    assert.equal(parseUsState(" ny "), "NY");
    assert.equal(parseUsState("dc"), "DC");
    for (const bad of ["ZZ", "Massachusetts", "", "M", ["MA"], 5, null, undefined]) assert.equal(parseUsState(bad), undefined, String(bad));
  });

  it("fills the one {q}, encoded; a store with no template has no search URL", () => {
    assert.equal(storeSearchUrl({ searchUrl: "https://stopandshop.com/product-search/{q}" }, "black beans & rice"), "https://stopandshop.com/product-search/black%20beans%20%26%20rice");
    assert.equal(storeSearchUrl({ searchUrl: null }, "milk"), null);
  });
});
