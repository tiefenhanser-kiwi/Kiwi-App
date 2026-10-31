// SERVER-6 B, SHOP-1 (D-WS9-325) — SHOP YOUR STORE: THE STORE REGISTRY.
//
// Every store a cook can order groceries from ONLINE, on the store's own site or on
// its Instacart storefront. A store with no online ordering is not here at all
// (Hans, D-WS9-325): Trader Joe's, Market Basket and WinCo are left out on purpose.
//
// The URLs live HERE, on the server, so a store that moves a page is a server fix,
// never an app update. Two surfaces read them:
//   • GET /stores (routes/stores.ts): the registry ranked for the cook's state, with
//     the sign-in and cart pages the Shop Your Store screen opens.
//   • GET /grocery-lists/:id: v0's search handoff, one line's search at a store
//     (`searchUrl`, `{q}` its one placeholder; storeSearchUrl below).
//
// SHOP-1 checked every URL on 2026-10-30, read-only: each page loaded with an
// Android WebView user agent, and on a single-page site the route was found in the
// site's own route table (a 200 alone proves nothing there). Nothing was signed in to.
//   `urlsStatus`     "checked"    — the sign-in and cart pages answered as themselves.
//                    "unverified" — a bot wall (Akamai, Imperva, Cloudflare) hid every
//                                   page; the paths are the platform's convention.
//   `searchUrlStatus` "documented" — the store publishes it (Wegmans' llms.txt).
//                    "checked"    — it loaded as that store's search page.
//                    "unverified" — hidden by a bot wall, as above.
//   `signInUrl` null — no sign-in page of its own was found: open `siteUrl`.
//   `cartUrl` null   — the cart is a drawer on the storefront (every Instacart
//                      storefront), or was not found: open `siteUrl`.
//   `searchUrl` null — no search template was found; v0's handoff skips the store.
//
// `webviewOk` is what curl could see, not a device test (Phase 0's T1 is still owed):
//   true  — every page loaded, no challenge, no "get the app" wall, and sign-in is
//           the store's own (an email and password, not a Google-only button).
//   false — the store must not open in a WebView: Whole Foods signs in with Amazon,
//           and Amazon Associates forbids WebViews.
//   null  — a JavaScript challenge hid a page from curl; a real WebView may pass it.
//
// `storeCounts` is stores per state, from the one public source named on the entry,
// read 2026-10-30. Its keys ARE the states served, and they rank the list:
// storesForState below. `affiliateProgram` is a programme's name where a public
// listing exists. Nobody has joined one; Hans does the sign-ups.
//
// `appUrl` — an app deep-link template. None researched: on Android the https link
// opens the store's app on its own when the app claims it (App Links), and iOS
// universal links do the same.

import { createHash } from "node:crypto";

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
  "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "PR", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

export type UsState = (typeof US_STATES)[number];

export interface RetailerStore {
  key: string;
  name: string;
  bannerGroup: string;
  orderType: "own_online" | "instacart";
  siteUrl: string;
  signInUrl: string | null;
  cartUrl: string | null;
  urlsStatus: "checked" | "unverified";
  searchUrl: string | null;
  searchUrlStatus: "documented" | "checked" | "unverified";
  appUrl: null;
  webviewOk: boolean | null;
  affiliateProgram: string | null;
  storeCounts: Readonly<Partial<Record<UsState, number>>>;
  countsSource: string;
  notes: string;
}

const SCRAPEHERO = "ScrapeHero location reports (scrapehero.com/location-reports), October 2026";
const STORELOCATORS = "storelocators.com store lists, read 2026-10-30";
const ALBERTSONS_PLATFORM = "Albertsons Companies' shared site: /account/sign-in.html, /erums/cart, /shop/search-results.html?q=.";
const AHOLD_PLATFORM = "Ahold Delhaize USA's shared site (the Peapod Digital Labs bundle): /login or /modal/login, /cart, /product-search/:keywords.";
const KROGER_PLATFORM =
  "The Kroger Co.'s shared site. Akamai stalled every request from curl and WebFetch on 2026-10-30, so /signin, /cart and /search?query= are the platform's paths, not loaded.";

// In Hans's order (D-WS9-325): Whole Foods and Aldi, his local stores, then the
// national and regional majors. The order breaks ties in the ranking.
export const SHOP_YOUR_STORE_STORES: readonly RetailerStore[] = [
  {
    key: "whole_foods",
    name: "Whole Foods Market",
    bannerGroup: "Amazon",
    orderType: "own_online",
    siteUrl: "https://www.wholefoodsmarket.com/",
    signInUrl: "https://www.wholefoodsmarket.com/api/wwos/auth/login?returnToUrl=/redirect",
    cartUrl: "https://www.wholefoodsmarket.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.wholefoodsmarket.com/grocery/search?k={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: false,
    affiliateProgram: "Amazon Associates",
    storeCounts: {
      CA: 93, TX: 36, FL: 35, MA: 32, NY: 31, IL: 27, NJ: 24, CO: 22, NC: 16, PA: 16,
      VA: 14, CT: 13, GA: 12, OH: 11, AZ: 10, MD: 10, OR: 10, WA: 10, DC: 8, MI: 8,
      TN: 8, LA: 7, MN: 7, IN: 5, NV: 5, NH: 5, HI: 4, MO: 4, SC: 4, UT: 4,
      AR: 3, KS: 3, NM: 3, OK: 3, RI: 3, WI: 3, AL: 2, KY: 2, NE: 2, ID: 1,
      IA: 1, ME: 1, MS: 1, MT: 1, WY: 1,
    },
    countsSource: STORELOCATORS,
    notes: "Sign-in hands off to amazon.com/ap/signin (an Amazon account). Amazon Associates forbids WebViews: open it in the browser or the Amazon app. v0's /search?text= redirected to /grocery/search?k=.",
  },
  {
    key: "aldi",
    name: "Aldi",
    bannerGroup: "ALDI Inc.",
    orderType: "instacart",
    siteUrl: "https://www.aldi.us/store/aldi/storefront",
    signInUrl: "https://www.aldi.us/login",
    cartUrl: null,
    urlsStatus: "checked",
    searchUrl: "https://www.aldi.us/store/aldi/s?k={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: {
      FL: 326, IL: 217, OH: 179, PA: 172, NY: 144, TX: 126, MI: 123, CA: 109, MO: 105, GA: 94,
      NC: 94, IN: 89, WI: 88, MN: 84, VA: 75, MD: 71, NJ: 69, TN: 67, AL: 58, SC: 56,
      IA: 41, CT: 34, OK: 32, LA: 30, KS: 29, KY: 28, MA: 25, AR: 21, MS: 20, AZ: 17,
      WV: 16, NE: 12, DE: 10, NH: 10, RI: 9, SD: 6, NV: 4, DC: 3, ND: 3, VT: 3,
      ME: 1,
    },
    countsSource: `${STORELOCATORS} (6 of its 2,706 have no state)`,
    notes: "An Instacart storefront on aldi.us; v0's shop.aldi.us now redirects there. The cart is a drawer (/store/aldi/cart is a 404).",
  },
  {
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
    storeCounts: { MA: 117, NY: 92, CT: 80, NJ: 45, RI: 25 },
    countsSource: "stores.stopandshop.com (the chain's directory), read 2026-10-30",
    notes: `${AHOLD_PLATFORM} v0's /search?q= was the catch-all page every path gets, not a search.`,
  },
  {
    key: "shaws",
    name: "Shaw's",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.shaws.com/",
    signInUrl: "https://www.shaws.com/account/sign-in.html",
    cartUrl: "https://www.shaws.com/erums/cart/",
    urlsStatus: "checked",
    searchUrl: "https://www.shaws.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { MA: 55, NH: 25, ME: 19, VT: 19, RI: 8 },
    countsSource: SCRAPEHERO,
    notes: `${ALBERTSONS_PLATFORM} The sign-in page gave curl Imperva's "Pardon Our Interruption" JavaScript challenge.`,
  },
  {
    key: "star_market",
    name: "Star Market",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.starmarket.com/",
    signInUrl: "https://www.starmarket.com/account/sign-in.html",
    cartUrl: "https://www.starmarket.com/erums/cart/",
    urlsStatus: "checked",
    searchUrl: "https://www.starmarket.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { MA: 21 },
    countsSource: SCRAPEHERO,
    notes: `${ALBERTSONS_PLATFORM} Run by Shaw's. The sign-in page gave curl the same Imperva challenge.`,
  },
  {
    key: "hannaford",
    name: "Hannaford",
    bannerGroup: "Ahold Delhaize USA",
    orderType: "own_online",
    siteUrl: "https://hannaford.com/",
    signInUrl: "https://hannaford.com/modal/login",
    cartUrl: "https://hannaford.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://hannaford.com/product-search/{q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { ME: 68, NY: 52, NH: 36, VT: 17, MA: 15 },
    countsSource: SCRAPEHERO,
    notes: AHOLD_PLATFORM,
  },
  {
    key: "wegmans",
    name: "Wegmans",
    bannerGroup: "Wegmans Food Markets",
    orderType: "own_online",
    siteUrl: "https://www.wegmans.com/",
    signInUrl: "https://www.wegmans.com/signin",
    cartUrl: "https://www.wegmans.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.wegmans.com/shop/search?query={q}",
    searchUrlStatus: "documented",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { NY: 50, PA: 19, VA: 15, MD: 9, NJ: 9, NC: 5, MA: 5, DC: 1, DE: 1, CT: 1 },
    countsSource: SCRAPEHERO,
    notes: "A store must be selected for prices. /shop/cart is a JSON stub, not the cart: /cart is.",
  },
  {
    key: "walmart",
    name: "Walmart",
    bannerGroup: "Walmart Inc.",
    orderType: "own_online",
    siteUrl: "https://www.walmart.com/",
    signInUrl: "https://www.walmart.com/account/login",
    cartUrl: "https://www.walmart.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.walmart.com/search?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: "Walmart Affiliates (Impact)",
    storeCounts: {
      TX: 510, FL: 345, CA: 272, NC: 192, GA: 184, IL: 152, OH: 142, MO: 137, TN: 136, PA: 135,
      VA: 133, AL: 130, LA: 123, OK: 121, AR: 115, AZ: 112, IN: 111, SC: 109, NY: 99, MI: 93,
      KY: 91, CO: 87, WI: 87, MS: 78, KS: 73, MN: 67, WA: 63, NJ: 62, IA: 60, UT: 52,
      MA: 48, MD: 46, NM: 45, NV: 43, OR: 43, NE: 42, WV: 38, CT: 31, ID: 26, NH: 26,
      ME: 22, PR: 18, SD: 15, MT: 14, ND: 14, WY: 12, AK: 9, DE: 9, HI: 9, RI: 9,
      VT: 6, DC: 2,
    },
    countsSource: STORELOCATORS,
    notes: "PerimeterX press-and-hold (\"Robot or human?\") answered curl's sign-in and a cookieless search; with the homepage's cookies, search was a real results page.",
  },
  {
    key: "target",
    name: "Target",
    bannerGroup: "Target Corporation",
    orderType: "own_online",
    siteUrl: "https://www.target.com/",
    signInUrl: "https://www.target.com/login",
    cartUrl: "https://www.target.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.target.com/s?searchTerm={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: "Target Partners (Impact)",
    storeCounts: {
      CA: 325, TX: 165, FL: 136, NY: 109, IL: 102, PA: 79, MN: 72, OH: 65, VA: 62, NC: 57,
      NJ: 56, MI: 54, AZ: 51, GA: 51, MA: 51, CO: 46, MD: 40, MO: 38, WA: 38, WI: 38,
      IN: 32, TN: 32, CT: 24, AL: 23, SC: 23, IA: 22, OR: 19, NV: 18, UT: 18, KS: 17,
      LA: 16, KY: 15, NE: 15, OK: 15, HI: 10, NH: 10, NM: 10, AR: 9, ID: 7, MS: 7,
      MT: 7, WV: 7, ME: 6, SD: 6, DE: 5, DC: 4, ND: 4, RI: 4, AK: 3, WY: 3, VT: 1,
    },
    countsSource: STORELOCATORS,
    notes: "",
  },
  {
    key: "kroger",
    name: "Kroger",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.kroger.com/",
    signInUrl: "https://www.kroger.com/signin",
    cartUrl: "https://www.kroger.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.kroger.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: "Kroger (FlexOffers)",
    storeCounts: {
      TX: 205, OH: 203, GA: 165, MI: 124, TN: 120, KY: 112, IN: 103, VA: 69, WV: 39, IL: 30,
      MS: 30, AR: 27, SC: 13, AL: 11, LA: 7, MO: 3,
    },
    countsSource: `${STORELOCATORS} (Kroger-branded stores only)`,
    notes: KROGER_PLATFORM,
  },
  {
    key: "ralphs",
    name: "Ralphs",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.ralphs.com/",
    signInUrl: "https://www.ralphs.com/signin",
    cartUrl: "https://www.ralphs.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.ralphs.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { CA: 189 },
    countsSource: SCRAPEHERO,
    notes: KROGER_PLATFORM,
  },
  {
    key: "fred_meyer",
    name: "Fred Meyer",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.fredmeyer.com/",
    signInUrl: "https://www.fredmeyer.com/signin",
    cartUrl: "https://www.fredmeyer.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.fredmeyer.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { OR: 55, WA: 55, ID: 11, AK: 11 },
    countsSource: SCRAPEHERO,
    notes: KROGER_PLATFORM,
  },
  {
    key: "king_soopers",
    name: "King Soopers",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.kingsoopers.com/",
    signInUrl: "https://www.kingsoopers.com/signin",
    cartUrl: "https://www.kingsoopers.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.kingsoopers.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { CO: 124, WY: 1 },
    countsSource: SCRAPEHERO,
    notes: KROGER_PLATFORM,
  },
  {
    key: "harris_teeter",
    name: "Harris Teeter",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.harristeeter.com/",
    signInUrl: "https://www.harristeeter.com/signin",
    cartUrl: "https://www.harristeeter.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.harristeeter.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { NC: 154, VA: 53, SC: 32, MD: 18, DC: 3, DE: 2, FL: 2, GA: 1 },
    countsSource: SCRAPEHERO,
    notes: `${KROGER_PLATFORM} Harris Teeter moved onto Kroger's platform in 2023.`,
  },
  {
    key: "frys",
    name: "Fry's Food Stores",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.frysfood.com/",
    signInUrl: "https://www.frysfood.com/signin",
    cartUrl: "https://www.frysfood.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.frysfood.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { AZ: 131 },
    countsSource: SCRAPEHERO,
    notes: KROGER_PLATFORM,
  },
  {
    key: "smiths",
    name: "Smith's Food and Drug",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.smithsfoodanddrug.com/",
    signInUrl: "https://www.smithsfoodanddrug.com/signin",
    cartUrl: "https://www.smithsfoodanddrug.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.smithsfoodanddrug.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { UT: 59, NV: 47, NM: 23, WY: 7, MT: 4, AZ: 4, ID: 3 },
    countsSource: SCRAPEHERO,
    notes: KROGER_PLATFORM,
  },
  {
    key: "qfc",
    name: "QFC",
    bannerGroup: "The Kroger Co.",
    orderType: "own_online",
    siteUrl: "https://www.qfc.com/",
    signInUrl: "https://www.qfc.com/signin",
    cartUrl: "https://www.qfc.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.qfc.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { WA: 54, OR: 4 },
    countsSource: SCRAPEHERO,
    notes: KROGER_PLATFORM,
  },
  {
    key: "albertsons",
    name: "Albertsons",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.albertsons.com/",
    signInUrl: "https://www.albertsons.com/account/sign-in.html",
    cartUrl: "https://www.albertsons.com/erums/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.albertsons.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: {
      CA: 123, TX: 41, ID: 37, NV: 34, MT: 30, AZ: 29, OR: 21, LA: 15, WY: 10, WA: 9,
      NM: 6, CO: 2, UT: 2, AR: 1, ND: 1, OK: 1,
    },
    countsSource: "local.albertsons.com (the banner's directory), read 2026-10-30",
    notes: ALBERTSONS_PLATFORM,
  },
  {
    key: "safeway",
    name: "Safeway",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.safeway.com/",
    signInUrl: "https://www.safeway.com/account/sign-in.html",
    cartUrl: "https://www.safeway.com/erums/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.safeway.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: "Safeway (CJ Affiliate)",
    storeCounts: {
      CA: 241, WA: 191, AZ: 109, OR: 96, CO: 92, MD: 59, VA: 37, HI: 23, AK: 12, DC: 11,
      MT: 9, ID: 7, NV: 7, WY: 5, NE: 4, DE: 3, NM: 3, SD: 3,
    },
    countsSource: "local.safeway.com (the banner's directory), read 2026-10-30",
    notes: `${ALBERTSONS_PLATFORM} Sign-in is an email or phone with a password or a code; its Google button will not work in a WebView, and nothing depends on it.`,
  },
  {
    key: "vons",
    name: "Vons",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.vons.com/",
    signInUrl: "https://www.vons.com/account/sign-in.html",
    cartUrl: "https://www.vons.com/erums/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.vons.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { CA: 177, NV: 8 },
    countsSource: "local.vons.com (the banner's directory), read 2026-10-30",
    notes: ALBERTSONS_PLATFORM,
  },
  {
    key: "jewel_osco",
    name: "Jewel-Osco",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.jewelosco.com/",
    signInUrl: "https://www.jewelosco.com/account/sign-in.html",
    cartUrl: "https://www.jewelosco.com/erums/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.jewelosco.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { IL: 184, IN: 5, IA: 1 },
    countsSource: "local.jewelosco.com (the banner's directory), read 2026-10-30",
    notes: ALBERTSONS_PLATFORM,
  },
  {
    key: "acme",
    name: "ACME Markets",
    bannerGroup: "Albertsons Companies",
    orderType: "own_online",
    siteUrl: "https://www.acmemarkets.com/",
    signInUrl: "https://www.acmemarkets.com/account/sign-in.html",
    cartUrl: "https://www.acmemarkets.com/erums/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.acmemarkets.com/shop/search-results.html?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { NJ: 67, PA: 50, NY: 16, DE: 14, MD: 6, CT: 3 },
    countsSource: SCRAPEHERO,
    notes: `${ALBERTSONS_PLATFORM} The sign-in page gave curl Imperva's JavaScript challenge, twice.`,
  },
  {
    key: "publix",
    name: "Publix",
    bannerGroup: "Publix Super Markets",
    orderType: "instacart",
    siteUrl: "https://delivery.publix.com/store/publix/storefront",
    signInUrl: "https://delivery.publix.com/login",
    cartUrl: null,
    urlsStatus: "checked",
    searchUrl: "https://delivery.publix.com/store/publix/s?k={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { FL: 900, GA: 220, AL: 97, SC: 75, NC: 66, TN: 62, VA: 24, KY: 11 },
    countsSource: SCRAPEHERO,
    notes: "An Instacart storefront. The cart is a drawer (/store/cart is a 404).",
  },
  {
    key: "heb",
    name: "H-E-B",
    bannerGroup: "H-E-B",
    orderType: "own_online",
    siteUrl: "https://www.heb.com/",
    signInUrl: "https://www.heb.com/login",
    cartUrl: "https://www.heb.com/cart",
    urlsStatus: "unverified",
    searchUrl: "https://www.heb.com/search?q={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { TX: 373 },
    countsSource: SCRAPEHERO,
    notes: "Curbside and delivery on heb.com. Every heb.com page gave curl an Imperva/Incapsula JavaScript challenge, a desktop user agent too.",
  },
  {
    key: "meijer",
    name: "Meijer",
    bannerGroup: "Meijer",
    orderType: "own_online",
    siteUrl: "https://www.meijer.com/",
    signInUrl: "https://www.meijer.com/shopping/login.html",
    cartUrl: "https://www.meijer.com/shopping/cart.html",
    urlsStatus: "unverified",
    searchUrl: "https://www.meijer.com/shopping/search.html?text={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { MI: 131, OH: 57, IN: 45, IL: 26, WI: 12, KY: 11 },
    countsSource: STORELOCATORS,
    notes: "Pickup and Home Delivery on meijer.com. Akamai answered every meijer.com page with 403 Access Denied.",
  },
  {
    key: "costco",
    name: "Costco",
    bannerGroup: "Costco Wholesale",
    orderType: "own_online",
    siteUrl: "https://www.costco.com/grocery-household.html",
    signInUrl: "https://www.costco.com/LogonForm",
    cartUrl: "https://www.costco.com/CheckoutCartDisplayView",
    urlsStatus: "checked",
    searchUrl: "https://www.costco.com/s?keyword={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: "Costco (CJ Affiliate)",
    storeCounts: {
      CA: 140, TX: 40, WA: 34, FL: 33, IL: 23, NJ: 21, AZ: 20, NY: 19, GA: 17, MI: 17,
      VA: 17, CO: 16, MN: 14, UT: 14, OH: 13, OR: 13, MD: 11, PA: 11, WI: 11, NC: 10,
      IN: 9, MO: 9, CT: 8, HI: 8, NV: 8, TN: 8, ID: 7, AK: 6, MA: 6, MT: 6,
      SC: 6, AL: 5, PR: 5, IA: 4, KY: 4, LA: 4, NE: 4, OK: 4, KS: 3, NM: 3,
      ND: 2, AR: 1, DE: 1, DC: 1, ME: 1, MS: 1, NH: 1, SD: 1, VT: 1,
    },
    countsSource: STORELOCATORS,
    notes: "Members. Sign-in goes to Costco's Azure AD B2C page (signin.costco.com). Same-Day grocery is Instacart's sameday.costco.com, a separate login.",
  },
  {
    key: "sams_club",
    name: "Sam's Club",
    bannerGroup: "Walmart Inc.",
    orderType: "own_online",
    siteUrl: "https://www.samsclub.com/",
    signInUrl: "https://www.samsclub.com/login",
    cartUrl: "https://www.samsclub.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.samsclub.com/search?q={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: "Sam's Club (Rakuten Advertising)",
    storeCounts: {
      TX: 82, FL: 46, CA: 30, OH: 27, IL: 25, GA: 24, PA: 24, MI: 23, NC: 22, MO: 19,
      CO: 17, TN: 15, VA: 15, LA: 14, AL: 13, AZ: 13, IN: 13, OK: 13, SC: 13, MN: 12,
      NY: 12, MD: 11, AR: 10, WI: 10, IA: 9, KS: 9, KY: 9, NJ: 8, UT: 8, MS: 7,
      NV: 7, NM: 7, PR: 7, NE: 5, WV: 5, ME: 3, ND: 3, HI: 2, MT: 2, NH: 2,
      SD: 2, WY: 2, CT: 1, DE: 1, ID: 1,
    },
    countsSource: STORELOCATORS,
    notes: "Members. Sign-in loads PerimeterX (Walmart's bot check); curl was not challenged.",
  },
  {
    key: "giant_food",
    name: "Giant Food",
    bannerGroup: "Ahold Delhaize USA",
    orderType: "own_online",
    siteUrl: "https://giantfood.com/",
    signInUrl: "https://giantfood.com/login",
    cartUrl: "https://giantfood.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://giantfood.com/product-search/{q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: "Giant Food (FlexOffers)",
    storeCounts: { MD: 94, VA: 58, DC: 7, DE: 6 },
    countsSource: SCRAPEHERO,
    notes: `${AHOLD_PLATFORM} Landover, MD.`,
  },
  {
    key: "giant_company",
    name: "The Giant Company",
    bannerGroup: "Ahold Delhaize USA",
    orderType: "own_online",
    siteUrl: "https://giantfoodstores.com/",
    signInUrl: "https://giantfoodstores.com/login",
    cartUrl: "https://giantfoodstores.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://giantfoodstores.com/product-search/{q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { PA: 168 },
    countsSource: `${SCRAPEHERO}: 202 with Martin's, less Martin's 34 (PA 9, VA 12, MD 8, WV 5)`,
    notes: `${AHOLD_PLATFORM} Carlisle, PA. Its Martin's stores order on martinsfoods.com, a banner not in this registry.`,
  },
  {
    key: "giant_eagle",
    name: "Giant Eagle",
    bannerGroup: "Giant Eagle",
    orderType: "own_online",
    siteUrl: "https://www.gianteagle.com/",
    signInUrl: "https://www.gianteagle.com/login",
    cartUrl: "https://www.gianteagle.com/cart",
    urlsStatus: "checked",
    searchUrl: null,
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { OH: 93, PA: 92, WV: 2, MD: 2 },
    countsSource: SCRAPEHERO,
    notes: "Sign-in is Giant Eagle's Azure AD B2C page (login.accounts.gianteagle.com), an email and password. The site has a /search route but its query parameter was not found.",
  },
  {
    key: "shoprite",
    name: "ShopRite",
    bannerGroup: "Wakefern Food Corp.",
    orderType: "own_online",
    siteUrl: "https://www.shoprite.com/",
    signInUrl: null,
    cartUrl: null,
    urlsStatus: "unverified",
    searchUrl: null,
    searchUrlStatus: "unverified",
    appUrl: null,
    webviewOk: null,
    affiliateProgram: null,
    storeCounts: { NJ: 181, NY: 58, PA: 31, CT: 29, MD: 10, DE: 6 },
    countsSource: SCRAPEHERO,
    notes: "ShopRite from Home, pickup or delivery per store; its pages sit under /sm/pickup/rsid/{storeId}/, so they need the cook's store. Cloudflare's \"Just a moment...\" challenge answered every request.",
  },
  {
    key: "food_lion",
    name: "Food Lion",
    bannerGroup: "Ahold Delhaize USA",
    orderType: "own_online",
    siteUrl: "https://foodlion.com/",
    signInUrl: "https://foodlion.com/login",
    cartUrl: "https://foodlion.com/cart",
    urlsStatus: "checked",
    searchUrl: "https://foodlion.com/product-search/{q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: "Food Lion (FlexOffers)",
    storeCounts: { NC: 529, VA: 291, SC: 176, MD: 52, GA: 46, TN: 27, DE: 20, WV: 16, KY: 4, PA: 3 },
    countsSource: SCRAPEHERO,
    notes: AHOLD_PLATFORM,
  },
  {
    key: "sprouts",
    name: "Sprouts Farmers Market",
    bannerGroup: "Sprouts Farmers Market",
    orderType: "instacart",
    siteUrl: "https://shop.sprouts.com/store/sprouts/storefront",
    signInUrl: "https://shop.sprouts.com/login",
    cartUrl: null,
    urlsStatus: "checked",
    searchUrl: "https://shop.sprouts.com/store/sprouts/s?k={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: {
      CA: 160, TX: 69, FL: 63, AZ: 51, CO: 34, GA: 19, NV: 17, OK: 11, NM: 10, TN: 10,
      MD: 8, PA: 8, NJ: 7, NC: 7, UT: 7, VA: 5, KS: 4, AL: 3, DE: 3, MO: 3,
      NY: 3, WA: 3, SC: 2, LA: 1, WY: 1,
    },
    countsSource: STORELOCATORS,
    notes: "An Instacart storefront. The cart is a drawer.",
  },
  {
    key: "hy_vee",
    name: "Hy-Vee",
    bannerGroup: "Hy-Vee",
    orderType: "own_online",
    siteUrl: "https://www.hy-vee.com/",
    signInUrl: "https://www.hy-vee.com/main/login",
    cartUrl: "https://www.hy-vee.com/aisles-online/checkout/cart",
    urlsStatus: "checked",
    searchUrl: "https://www.hy-vee.com/aisles-online/search?search={q}",
    searchUrlStatus: "checked",
    appUrl: null,
    webviewOk: true,
    affiliateProgram: null,
    storeCounts: { IA: 131, MN: 33, NE: 32, MO: 30, IL: 17, SD: 12, KS: 11, WI: 9 },
    countsSource: STORELOCATORS,
    notes: "Aisles Online. Sign-in redirects to Hy-Vee's Auth0 page (identity.hy-vee.com), an email and password.",
  },
];

const BY_KEY = new Map(SHOP_YOUR_STORE_STORES.map((s) => [s.key, s]));
const ORDER = new Map(SHOP_YOUR_STORE_STORES.map((s, i) => [s.key, i]));
const US_STATE_SET: ReadonlySet<string> = new Set(US_STATES);

export function storeByKey(key: string): RetailerStore | null {
  return BY_KEY.get(key) ?? null;
}

export function isRegistryStoreKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** "MA", " ma " → "MA". Anything that is not one US state code (an array, "ZZ") → undefined. */
export function parseUsState(raw: unknown): UsState | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim().toUpperCase();
  return US_STATE_SET.has(code) ? (code as UsState) : undefined;
}

/** The store's stores in one state, or nationally (state null). 0 = it does not serve that state. */
export function storeCountIn(store: Pick<RetailerStore, "storeCounts">, state: UsState | null): number {
  if (state !== null) return store.storeCounts[state] ?? 0;
  let total = 0;
  for (const n of Object.values(store.storeCounts)) total += n ?? 0;
  return total;
}

/**
 * The stores that serve `state`, most stores there first; with no state, every
 * store, most stores nationally first. A tie keeps the registry's order (Hans's).
 */
export function storesForState(
  state: UsState | null,
  stores: readonly RetailerStore[] = SHOP_YOUR_STORE_STORES,
): RetailerStore[] {
  const order = stores === SHOP_YOUR_STORE_STORES ? ORDER : new Map(stores.map((s, i) => [s.key, i]));
  return stores
    .map((store) => ({ store, n: storeCountIn(store, state) }))
    .filter(({ n }) => n > 0)
    .sort((a, b) => b.n - a.n || order.get(a.store.key)! - order.get(b.store.key)!)
    .map(({ store }) => store);
}

/** One store on GET /stores: what the screen opens, and how sure SHOP-1 was of it. */
export function toStoreWire(store: RetailerStore, state: UsState | null) {
  return {
    key: store.key,
    name: store.name,
    bannerGroup: store.bannerGroup,
    orderType: store.orderType,
    siteUrl: store.siteUrl,
    signInUrl: store.signInUrl,
    cartUrl: store.cartUrl,
    urlsStatus: store.urlsStatus,
    searchUrl: store.searchUrl,
    searchUrlStatus: store.searchUrlStatus,
    appUrl: store.appUrl,
    webviewOk: store.webviewOk,
    affiliateProgram: store.affiliateProgram,
    states: US_STATES.filter((s) => (store.storeCounts[s] ?? 0) > 0),
    /** In `state`, or nationally when there is none. */
    storeCount: storeCountIn(store, state),
  };
}

/**
 * The registry's version: the first 12 hex of a sha256 over the stores as listed.
 * Any change to an entry (a URL, a count, the order) moves it, with nobody to
 * remember a bump. The client caches GET /stores against it.
 */
export function storesVersionOf(stores: readonly RetailerStore[]): string {
  return createHash("sha256").update(JSON.stringify(stores)).digest("hex").slice(0, 12);
}

export const STORES_VERSION = storesVersionOf(SHOP_YOUR_STORE_STORES);

/** One line's search page at this store; null when the store has no search template. */
export function storeSearchUrl(store: Pick<RetailerStore, "searchUrl">, searchTerm: string): string | null {
  return store.searchUrl === null ? null : store.searchUrl.replace("{q}", encodeURIComponent(searchTerm));
}

export const SHOP_YOUR_STORE_DISCLOSURE = "Kiwi may earn a commission from some store links.";
