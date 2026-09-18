// Row 5 · Block 1 (D-WS9-246 step 1) — publisher-image extraction.
// Run via: pnpm --filter @workspace/api-server test
//
// Order JSON-LD → og:image → twitter:image; every JSON-LD `image` shape; the
// two rejection rules; and the one the ruling underlines: an <img> element is
// NEVER a candidate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractPageImage,
  hasRejectedFilenameShape,
  MIN_EDGE_PX,
} from "../images/pageImageExtractor";

const page = (opts: { jsonld?: unknown; head?: string; body?: string }) => `<!doctype html>
<html><head>
${opts.jsonld !== undefined ? `<script type="application/ld+json">${JSON.stringify(opts.jsonld)}</script>` : ""}
${opts.head ?? ""}
</head><body>${opts.body ?? ""}</body></html>`;

const recipe = (image: unknown, extra: Record<string, unknown> = {}) => ({
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Birria Tacos",
  image,
  ...extra,
});

describe("extractPageImage — JSON-LD shapes", () => {
  it("string image", () => {
    const r = extractPageImage(page({ jsonld: recipe("https://x.test/i/birria.jpg") }));
    assert.equal(r.accepted?.url, "https://x.test/i/birria.jpg");
    assert.equal(r.accepted?.origin, "jsonld");
  });

  it("array of strings — first usable wins", () => {
    const r = extractPageImage(
      page({ jsonld: recipe(["https://x.test/i/a.jpg", "https://x.test/i/b.jpg"]) }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/a.jpg");
  });

  it("ImageObject with url + declared dimensions", () => {
    const r = extractPageImage(
      page({ jsonld: recipe({ "@type": "ImageObject", url: "https://x.test/i/c.jpg", width: 1200, height: 800 }) }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/c.jpg");
    assert.equal(r.accepted?.width, 1200);
    assert.equal(r.accepted?.height, 800);
  });

  it("ImageObject with contentUrl and string dimensions", () => {
    const r = extractPageImage(
      page({ jsonld: recipe({ "@type": "ImageObject", contentUrl: "https://x.test/i/d.jpg", width: "1024px", height: "683" }) }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/d.jpg");
    assert.equal(r.accepted?.width, 1024);
    assert.equal(r.accepted?.height, 683);
  });

  it("@graph shape — the Recipe node inside a graph", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "x" },
        { "@type": "Recipe", name: "Pho", image: [{ "@type": "ImageObject", url: "https://x.test/i/pho.jpg" }] },
      ],
    };
    const r = extractPageImage(page({ jsonld: graph }));
    assert.equal(r.accepted?.url, "https://x.test/i/pho.jpg");
  });

  it("JSON-LD wins over og:image when both are present", () => {
    const r = extractPageImage(
      page({
        jsonld: recipe("https://x.test/i/ld.jpg"),
        head: `<meta property="og:image" content="https://x.test/i/og.jpg">`,
      }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/ld.jpg");
  });
});

describe("extractPageImage — og / twitter fallbacks", () => {
  it("no JSON-LD → og:image", () => {
    const r = extractPageImage(
      page({ head: `<meta property="og:image" content="https://x.test/i/og.jpg"><meta property="og:image:width" content="1200">` }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/og.jpg");
    assert.equal(r.accepted?.origin, "og");
    assert.equal(r.accepted?.width, 1200);
  });

  it("og:image:secure_url is preferred over og:image", () => {
    const r = extractPageImage(
      page({
        head: `<meta property="og:image" content="http://x.test/i/og.jpg"><meta property="og:image:secure_url" content="https://x.test/i/og-s.jpg">`,
      }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/og-s.jpg");
  });

  it("no JSON-LD, no og → twitter:image (name= or property=)", () => {
    const r = extractPageImage(page({ head: `<meta name="twitter:image" content="https://x.test/i/tw.jpg">` }));
    assert.equal(r.accepted?.url, "https://x.test/i/tw.jpg");
    assert.equal(r.accepted?.origin, "twitter");
    const r2 = extractPageImage(page({ head: `<meta property="twitter:image:src" content="https://x.test/i/tw2.jpg">` }));
    assert.equal(r2.accepted?.url, "https://x.test/i/tw2.jpg");
  });

  it("a rejected JSON-LD image falls through to og:image, and the rejection is recorded", () => {
    const r = extractPageImage(
      page({
        jsonld: recipe("https://x.test/i/site-logo.png"),
        head: `<meta property="og:image" content="https://x.test/i/og.jpg">`,
      }),
    );
    assert.equal(r.accepted?.url, "https://x.test/i/og.jpg");
    assert.deepEqual(r.rejected, [
      { url: "https://x.test/i/site-logo.png", origin: "jsonld", reason: "filename_shape" },
    ]);
  });
});

describe("extractPageImage — rejections", () => {
  it(`declared dimension under ${MIN_EDGE_PX} px is too_small; undeclared is not a rejection`, () => {
    const small = extractPageImage(
      page({ head: `<meta property="og:image" content="https://x.test/i/og.jpg"><meta property="og:image:width" content="399">` }),
    );
    assert.equal(small.accepted, null);
    assert.equal(small.rejected[0]?.reason, "too_small");
    const undeclared = extractPageImage(page({ head: `<meta property="og:image" content="https://x.test/i/og.jpg">` }));
    assert.equal(undeclared.accepted?.url, "https://x.test/i/og.jpg");
  });

  it("filename shapes: logo / sprite / icon / avatar / placeholder / banner / ad", () => {
    for (const name of [
      "site-logo.png",
      "logo_2x.svg",
      "sprite.png",
      "icons/apple-icon.png",
      "favicon.ico",
      "avatar-64.jpg",
      "placeholder.jpg",
      "hero-banner.jpg",
      "ad-300x250.jpg",
      "ads/creative.jpg",
      "advert.jpg",
    ]) {
      assert.equal(hasRejectedFilenameShape(`https://x.test/${name}`), true, name);
    }
    // Not false positives: "catalogo", "bad", "radish", "iconic-dish".
    for (const name of ["catalogo-tacos.jpg", "bad-dish.jpg", "radish-salad.jpg", "iconic-dish.jpg", "birria.jpg"]) {
      assert.equal(hasRejectedFilenameShape(`https://x.test/i/${name}`), false, name);
    }
  });

  it("non-http(s) candidate is not_http", () => {
    const r = extractPageImage(page({ head: `<meta property="og:image" content="data:image/png;base64,AAAA">` }));
    assert.equal(r.accepted, null);
    assert.equal(r.rejected[0]?.reason, "not_http");
  });

  it("🔴 an <img> element is NEVER a candidate — a page with only <img> tags yields null", () => {
    const r = extractPageImage(
      page({
        body: `<img src="https://ads.test/creative-1.jpg" width="1200" height="800"><img src="https://x.test/i/real-dish.jpg" width="1600" height="1000">`,
      }),
    );
    assert.equal(r.accepted, null);
    assert.deepEqual(r.rejected, []);
  });
});
