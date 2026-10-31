// IMPORT-2 (D-WS9-384) — "Open the site and import". Some recipe sites refuse
// the server's own fetch (NYT Cooking, Allrecipes) or sit behind the cook's
// sign-in. The cook opens the site inside Kiwi (app/import-browser.tsx), signs
// in if they need to, lands on the recipe and taps Import: the page they are
// looking at is read in the WebView and sent to POST /recipes/import-url as
// `html`, where the server's parser reads it instead of fetching anything.
//
// The decisions live here so they are testable without a WebView: what the
// field accepts, the recent-sites list, which navigations the browser makes,
// the script that reads the page and the message it sends back.
//
// What persists, and where: a site's sign-in lives ONLY in the WebView's own
// cookie jar (WKWebsiteDataStore.default on iOS, CookieManager on Android).
// Kiwi never sees or stores a password. Kiwi's own storage keeps the origins
// of the last few sites opened (RECENT_SITES_KEY), nothing more.

export const RECENT_SITES_KEY = "import-browser:recent-sites";
export const MAX_RECENT_SITES = 6;

/** The server's MAX_PAGE_HTML_CHARS (api-server routes/recipes.ts). */
export const MAX_PAGE_HTML_CHARS = 1_000_000;

/** How long the page has to answer a tap before the bar says so. One try. */
export const PAGE_CAPTURE_TIMEOUT_MS = 10_000;

export const PAGE_MESSAGE_TYPE = "kiwi-import-page";

/**
 * Whether "Open the site and import" is offered. Only in the app: a web page
 * cannot embed another site (frame-ancestors / X-Frame-Options refuse it, and
 * a cross-origin frame's DOM is unreadable), so the Expo web build hides it.
 * 1.2-only: the 1.1 binary has no WebView module.
 */
export function showsSiteImport(os: string): boolean {
  return os === "ios" || os === "android";
}

export interface RecipeSite {
  label: string;
  url: string;
}

export const RECIPE_SITES: readonly RecipeSite[] = [
  { label: "NYT Cooking", url: "https://cooking.nytimes.com" },
  { label: "Allrecipes", url: "https://www.allrecipes.com" },
  { label: "Food Network", url: "https://www.foodnetwork.com" },
  { label: "Serious Eats", url: "https://www.seriouseats.com" },
  { label: "Bon Appétit", url: "https://www.bonappetit.com" },
  { label: "Budget Bytes", url: "https://www.budgetbytes.com" },
];

/**
 * What the field accepts: a web address, with or without its scheme
 * ("cooking.nytimes.com", "www.allrecipes.com/recipe/…"). The same shapes the
 * Paste-a-link screen takes. Anything else is null.
 */
export function normalizeSiteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^[^\s/]+\.[^\s]+/.test(trimmed)
      ? `https://${trimmed}`
      : null;
  if (!candidate || /\s/.test(candidate)) return null;
  return isWebUrl(candidate) ? candidate : null;
}

export function isWebUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === "https:" || protocol === "http:") && hostname.length > 0;
  } catch {
    return false;
  }
}

/** The origin a recent-sites row keeps: never a path or a query. */
export function siteOrigin(url: string): string | null {
  if (!isWebUrl(url)) return null;
  return new URL(url).origin;
}

/** The host the address bar shows, without a leading "www.". */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The label a recent site shows: its RECIPE_SITES name, else its host. */
export function siteLabel(origin: string): string {
  const known = RECIPE_SITES.find((s) => siteOrigin(s.url) === origin);
  return known ? known.label : displayHost(origin);
}

/** Most recent first, one row per origin, at most MAX_RECENT_SITES. */
export function addRecentSite(recent: readonly string[], url: string): string[] {
  const origin = siteOrigin(url);
  const kept = readRecentSites(recent);
  if (!origin) return kept;
  return [origin, ...kept.filter((r) => r !== origin)].slice(0, MAX_RECENT_SITES);
}

/** A stored list read back: anything that is not an origin is dropped. */
export function readRecentSites(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const origins = stored.filter((r): r is string => typeof r === "string" && siteOrigin(r) === r);
  return [...new Set(origins)].slice(0, MAX_RECENT_SITES);
}

/**
 * Which loads the browser makes. Web pages (and the blank page a WebView
 * starts on) load; anything else — an app link (intent:, market:, a store's
 * own scheme), tel:, mailto:, javascript:, file:, data: — is refused, so a
 * page cannot leave Kiwi or reach the device's files.
 */
export function browserAllowsNavigation(url: string): boolean {
  if (url === "about:blank" || url === "about:srcdoc") return true;
  return isWebUrl(url);
}

/**
 * Tags dropped from the copy of the page before it leaves the device. The
 * server's parser drops script, style, noscript, svg, header, footer, nav and
 * form already (htmlToText), so dropping them here changes nothing it reads —
 * but it keeps a signed-in page's account header, inline app state and form
 * values on the phone. The page's JSON-LD is read BEFORE this, and kept.
 */
export const PAGE_DROP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "picture",
  "img",
  "link",
  "meta",
  "header",
  "footer",
  "nav",
  "form",
  "input",
  "textarea",
  "select",
  "button",
  "dialog",
].join(",");

/**
 * The script the WebView runs when the cook taps Import. It reads the page as
 * the cook sees it now, builds a small copy — the page's JSON-LD blocks, its
 * title and its body with the tags above dropped and every attribute removed —
 * and posts it back once. `nonce` ties the answer to the tap.
 */
export function pageCaptureScript(nonce: string): string {
  return `(function () {
  var post = function (m) {
    m.type = ${JSON.stringify(PAGE_MESSAGE_TYPE)};
    m.nonce = ${JSON.stringify(nonce)};
    window.ReactNativeWebView.postMessage(JSON.stringify(m));
  };
  try {
    var slash = String.fromCharCode(92) + "/";
    var ld = [].slice
      .call(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(function (s) { return (s.textContent || "").split("</").join("<" + slash); })
      .filter(function (t) { return t.trim().length > 0; });
    var body = document.body ? document.body.cloneNode(true) : document.createElement("body");
    var drop = body.querySelectorAll(${JSON.stringify(PAGE_DROP_SELECTOR)});
    for (var i = 0; i < drop.length; i++) {
      if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    }
    var all = [body].concat([].slice.call(body.querySelectorAll("*")));
    for (var j = 0; j < all.length; j++) {
      while (all[j].attributes.length > 0) all[j].removeAttribute(all[j].attributes[0].name);
    }
    var title = document.createElement("title");
    title.textContent = document.title || "";
    var head = "<head>" + title.outerHTML + ld.map(function (t) {
      return '<script type="application/ld+json">' + t + "</scr" + "ipt>";
    }).join("") + "</head>";
    post({ url: String(location.href), html: "<!doctype html><html>" + head + body.outerHTML + "</html>" });
  } catch (e) {
    post({ url: String(location.href), error: String(e && e.message ? e.message : e) });
  }
})();
true;`;
}

export type PageCaptureResult =
  | { kind: "page"; url: string; html: string }
  | { kind: "failed" };

/**
 * The WebView's answer, read back. null = not an answer to this tap (another
 * message, or a stale nonce): the screen ignores it. A page past the server's
 * cap is cut to it: the JSON-LD comes first in the copy, so the cut takes the
 * end of the body text.
 */
export function parsePageCaptureMessage(data: string, nonce: string): PageCaptureResult | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m["type"] !== PAGE_MESSAGE_TYPE || m["nonce"] !== nonce) return null;
  const url = m["url"];
  const html = m["html"];
  if (typeof url !== "string" || !isWebUrl(url)) return { kind: "failed" };
  if (typeof html !== "string" || html.trim().length === 0) return { kind: "failed" };
  return { kind: "page", url, html: html.slice(0, MAX_PAGE_HTML_CHARS) };
}

export const PAGE_CAPTURE_FAILED_MESSAGE =
  "Kiwi couldn't read this page. Wait for it to finish loading, then tap Import again.";
