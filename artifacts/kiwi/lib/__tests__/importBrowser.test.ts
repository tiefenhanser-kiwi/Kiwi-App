// IMPORT-2 (D-WS9-384) — "Open the site and import": the field, recent sites,
// which loads the in-app browser makes, the page script's answer, and what the
// import sends. The WebView itself is device-verified; the page script was run
// against real sites in IMPORT-2's D proof (Chromium, dev :3140). Every
// expectation is a literal (§27.4).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { importRecipeFromUrl } from "../api/recipeImport";
import {
  addRecentSite,
  browserAllowsNavigation,
  displayHost,
  normalizeSiteInput,
  pageCaptureScript,
  parsePageCaptureMessage,
  readRecentSites,
  showsSiteImport,
  siteLabel,
} from "../import/inAppBrowser";

test("the option shows in the app only, never in the web build", () => {
  assert.equal(showsSiteImport("ios"), true);
  assert.equal(showsSiteImport("android"), true);
  assert.equal(showsSiteImport("web"), false);
  assert.equal(showsSiteImport("windows"), false);
});

test("the field takes a web address with or without its scheme", () => {
  assert.equal(normalizeSiteInput("cooking.nytimes.com"), "https://cooking.nytimes.com");
  assert.equal(normalizeSiteInput("  www.allrecipes.com/recipe/1 "), "https://www.allrecipes.com/recipe/1");
  assert.equal(normalizeSiteInput("http://example.com/r"), "http://example.com/r");
  assert.equal(normalizeSiteInput("https://cooking.nytimes.com"), "https://cooking.nytimes.com");
  assert.equal(normalizeSiteInput(""), null);
  assert.equal(normalizeSiteInput("lasagna"), null);
  assert.equal(normalizeSiteInput("nyt cooking"), null);
  assert.equal(normalizeSiteInput("javascript:alert(1)"), null);
  assert.equal(normalizeSiteInput("file:///etc/passwd"), null);
});

test("recent sites keep origins only, most recent first, one each, six at most", () => {
  let recent: string[] = [];
  recent = addRecentSite(recent, "https://cooking.nytimes.com/recipes/1234-lasagna?smid=abc");
  assert.deepEqual(recent, ["https://cooking.nytimes.com"]);
  recent = addRecentSite(recent, "https://www.allrecipes.com/recipe/1/");
  recent = addRecentSite(recent, "https://cooking.nytimes.com/");
  assert.deepEqual(recent, ["https://cooking.nytimes.com", "https://www.allrecipes.com"]);
  for (const h of ["a.com", "b.com", "c.com", "d.com", "e.com"]) {
    recent = addRecentSite(recent, `https://${h}/x`);
  }
  assert.deepEqual(recent, [
    "https://e.com",
    "https://d.com",
    "https://c.com",
    "https://b.com",
    "https://a.com",
    "https://cooking.nytimes.com",
  ]);
  assert.deepEqual(addRecentSite(["https://a.com"], "not a url"), ["https://a.com"]);
});

test("a stored list read back drops anything that is not an origin", () => {
  assert.deepEqual(readRecentSites(null), []);
  assert.deepEqual(readRecentSites("https://a.com"), []);
  assert.deepEqual(
    readRecentSites(["https://a.com", "https://a.com", "https://b.com/path", 7, "javascript:x", "https://c.com"]),
    ["https://a.com", "https://c.com"],
  );
});

test("labels: a known site by its name, any other by its host", () => {
  assert.equal(siteLabel("https://cooking.nytimes.com"), "NYT Cooking");
  assert.equal(siteLabel("https://www.bonappetit.com"), "Bon Appétit");
  assert.equal(siteLabel("https://www.smittenkitchen.com"), "smittenkitchen.com");
  assert.equal(displayHost("https://www.allrecipes.com/recipe/1"), "allrecipes.com");
  assert.equal(displayHost("garbage"), "");
});

test("the browser loads web pages only: no app links, files or scripts", () => {
  assert.equal(browserAllowsNavigation("https://cooking.nytimes.com/recipes/1"), true);
  assert.equal(browserAllowsNavigation("http://example.com/"), true);
  assert.equal(browserAllowsNavigation("about:blank"), true);
  for (const url of [
    "intent://scan/#Intent;scheme=zxing;end",
    "market://details?id=com.nytimes.cooking",
    "nytcooking://recipe/1",
    "tel:5551234",
    "mailto:a@b.c",
    "javascript:alert(1)",
    "file:///data/data/com.kitchenwizard.kiwi/",
    "data:text/html,<b>x</b>",
  ]) {
    assert.equal(browserAllowsNavigation(url), false, url);
  }
});

test("the page script is one valid script that answers with the tap's nonce", () => {
  const script = pageCaptureScript("n-123");
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /"n-123"/);
  assert.match(script, /"kiwi-import-page"/);
  assert.match(script, /application\/ld\+json/);
  assert.match(script, /"script,style,noscript,template,svg,canvas,iframe,object,embed,video,audio,picture,img,link,meta,header,footer,nav,form,input,textarea,select,button,dialog"/);
});

test("the page's answer: only this tap's, a web address, a page; cut to the server's cap", () => {
  const ok = JSON.stringify({ type: "kiwi-import-page", nonce: "n1", url: "https://cooking.nytimes.com/r/1", html: "<html>x</html>" });
  assert.deepEqual(parsePageCaptureMessage(ok, "n1"), {
    kind: "page",
    url: "https://cooking.nytimes.com/r/1",
    html: "<html>x</html>",
  });
  assert.equal(parsePageCaptureMessage(ok, "n2"), null);
  assert.equal(parsePageCaptureMessage("not json", "n1"), null);
  assert.equal(parsePageCaptureMessage(JSON.stringify({ type: "turnstile", nonce: "n1" }), "n1"), null);
  assert.deepEqual(
    parsePageCaptureMessage(JSON.stringify({ type: "kiwi-import-page", nonce: "n1", url: "https://a.com", error: "boom" }), "n1"),
    { kind: "failed" },
  );
  assert.deepEqual(
    parsePageCaptureMessage(JSON.stringify({ type: "kiwi-import-page", nonce: "n1", url: "file:///x", html: "<p>x</p>" }), "n1"),
    { kind: "failed" },
  );
  const big = JSON.stringify({ type: "kiwi-import-page", nonce: "n1", url: "https://a.com", html: "x".repeat(1_000_050) });
  const cut = parsePageCaptureMessage(big, "n1");
  assert.equal(cut?.kind, "page");
  assert.equal(cut && cut.kind === "page" ? cut.html.length : -1, 1_000_000);
});

// ── what the import sends ───────────────────────────────────────────────

let bodies: unknown[];
beforeEach(() => {
  bodies = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ success: false, reason: "url_parse_failed", userFacingMessage: "no recipe" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    "kiwi_authToken",
    "test-token",
  );
});
afterEach(() => {
  bodies = [];
});

test("a page import sends the address and the page; a link import is unchanged", async () => {
  await importRecipeFromUrl({ url: "https://cooking.nytimes.com/r/1", html: "<html>page</html>" });
  await importRecipeFromUrl({ url: "https://www.seriouseats.com/r" });
  assert.deepEqual(bodies, [
    { url: "https://cooking.nytimes.com/r/1", html: "<html>page</html>" },
    { url: "https://www.seriouseats.com/r" },
  ]);
});

test("a page that is not a recipe comes back as the importer's own failure", async () => {
  const result = await importRecipeFromUrl({ url: "https://a.com/", html: "<p>hi</p>" });
  assert.deepEqual(result, { success: false, reason: "url_parse_failed", userFacingMessage: "no recipe" });
});
