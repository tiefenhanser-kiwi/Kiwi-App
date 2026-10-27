// SERVER-6 B (D-WS9-325) — SHOP YOUR STORE v0: THE STORE REGISTRY.
//
// v0 is a handoff, not a WebView (SHOP-0 Phase 0 §3): the list stays in Kiwi,
// and a line opens that store's own search for it in the system browser, or in
// the store's app when the app claims the link. Kiwi only builds a URL the
// store publishes for its own search box. No cart, no scraping, no prices.
//
// The templates live HERE, on the server, so a store that moves its search page
// is a server fix, never an app update. `{q}` is the one placeholder; the caller
// substitutes the row's encodeURIComponent(searchTerm) (storeSearchUrl below).
//
// `searchUrlStatus` is what SHOP-0 could say about the template
// (scripts/_scratch/shop-0/stores.csv, read 2026-10-25, no shopping page fetched):
//   "documented"  — the store publishes it (Wegmans' llms.txt). The only one.
//   "unverified"  — the observed convention; Phase 0's device test T1 is owed.
//   "unknown"     — Phase 0 found no pattern; the template is a guess.
// Each store is meant to stay behind the flag until its T1 passes.
//
// `appUrl` — an app deep-link template. Phase 0 researched none, so every entry
// is null: on Android the https link opens the store's app on its own when the
// app claims it (App Links); iOS universal links behave the same way.
//
// `affiliate` — an affiliate slot for the day a programme is joined. Null for
// every store today.

export interface RetailerStore {
  key: string;
  name: string;
  searchUrl: string;
  searchUrlStatus: "documented" | "unverified" | "unknown";
  appUrl: string | null;
  affiliate: null;
  region: string;
}

export const SHOP_YOUR_STORE_STORES: readonly RetailerStore[] = [
  {
    key: "kroger",
    name: "Kroger",
    searchUrl: "https://www.kroger.com/search?query={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "National through its banners (Ralphs, Fred Meyer, King Soopers, Harris Teeter, Smith's, Fry's, QFC, Dillons, Mariano's, Pick 'n Save); the same path is on the banner domains.",
  },
  {
    key: "aldi",
    name: "Aldi",
    searchUrl: "https://shop.aldi.us/store/aldi/s?k={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "US. aldi.us has run on Instacart Storefront Pro since 2026-03-30; this shop.aldi.us path may be the legacy one.",
  },
  {
    key: "whole_foods",
    name: "Whole Foods",
    searchUrl: "https://www.wholefoodsmarket.com/search?text={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "National (Amazon). Browser or the Amazon app only, never a WebView (Associates policy).",
  },
  {
    key: "walmart",
    name: "Walmart",
    searchUrl: "https://www.walmart.com/search?q={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "National; grocery is on the main site. A press-and-hold bot wall was seen by Phase 0's fetcher.",
  },
  {
    key: "target",
    name: "Target",
    searchUrl: "https://www.target.com/s?searchTerm={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "National.",
  },
  {
    key: "costco",
    name: "Costco",
    searchUrl: "https://www.costco.com/CatalogSearch?keyword={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "National, members. Same-Day grocery is Instacart's sameday.costco.com/store/costco/s?k=, a different login.",
  },
  {
    key: "publix",
    name: "Publix",
    searchUrl: "https://delivery.publix.com/store/publix/s?k={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "Southeast (FL, GA, AL, SC, NC, TN, VA, KY). Delivery runs on Instacart.",
  },
  {
    key: "heb",
    name: "H-E-B",
    searchUrl: "https://www.heb.com/search?q={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "Texas.",
  },
  {
    key: "wegmans",
    name: "Wegmans",
    searchUrl: "https://www.wegmans.com/shop/search?query={q}",
    searchUrlStatus: "documented",
    appUrl: null,
    affiliate: null,
    region: "Northeast and Mid-Atlantic. A store must be selected for prices.",
  },
  {
    key: "safeway",
    name: "Safeway",
    searchUrl: "https://www.safeway.com/shop/search-results.html?q={q}",
    searchUrlStatus: "unverified",
    appUrl: null,
    affiliate: null,
    region: "West and Mid-Atlantic (Albertsons Companies; its other banners have their own domains).",
  },
  {
    key: "stop_and_shop",
    name: "Stop & Shop",
    searchUrl: "https://stopandshop.com/search?q={q}",
    searchUrlStatus: "unknown",
    appUrl: null,
    affiliate: null,
    region: "Northeast (Ahold Delhaize USA). Phase 0 found no search pattern, and the site was down 2026-10-12 to 10-20.",
  },
];

const BY_KEY = new Map(SHOP_YOUR_STORE_STORES.map((s) => [s.key, s]));

export function storeByKey(key: string): RetailerStore | null {
  return BY_KEY.get(key) ?? null;
}

export function isRegistryStoreKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** One line's search page at this store. */
export function storeSearchUrl(store: Pick<RetailerStore, "searchUrl">, searchTerm: string): string {
  return store.searchUrl.replace("{q}", encodeURIComponent(searchTerm));
}

export const SHOP_YOUR_STORE_DISCLOSURE = "Kiwi may earn a commission from some store links.";
