// D-WS9-231 — the web fallback pages the emailed links land on.
//
// Hans's ruling (September 7): "https link + WEB FALLBACK PAGE now; universal
// links later on THE SAME URL", and "password reset is the flow most likely to
// be opened ON A LAPTOP, so the reset must be COMPLETABLE IN THE BROWSER — the
// web page is the PRIMARY surface and the app deep-link is the enhancement."
//
// So these are plain HTML strings served by Express at the ROOT of the host
// PUBLIC_APP_URL names (`/reset-password`, `/verify-email` — the two paths
// sendEmail.ts::buildAppLink already mints). No framework, no build step, no
// external asset: the markup lives in TypeScript template strings rather than
// .html files because the production bundle must not read the filesystem
// (the container's runtime layer carries dist/ and nothing else), and neither
// tsx (dev/tests) nor tsc understands an .html import without a loader.
//
// The `kiwi://` anchor on each page is the "same URL, app enhancement later"
// half of the ruling made concrete: it costs one tag today and becomes the
// universal-link target when that lands.

export const APP_SCHEME = "kiwi";

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f4; color: #1d2320;
  }
  main { width: min(28rem, calc(100vw - 2rem)); padding: 2rem 1.5rem;
    background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; }
  label { display: block; font-weight: 600; margin-top: 1rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-top: .25rem;
    font: inherit; border: 1px solid #b8bfb9; border-radius: 8px; }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem; font: inherit; font-weight: 600;
    color: #fff; background: #2f7d4e; border: 0; border-radius: 8px; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  .hint { font-size: .875rem; color: #5b655e; }
  .error { color: #a03030; }
  .ok { color: #2f7d4e; }
  .app-link { display: block; margin-top: 1.5rem; font-size: .875rem; text-align: center; color: #2f7d4e; }
  [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    body { background: #141815; color: #e6ebe7; }
    main { background: #1f2622; box-shadow: none; }
    input { background: #141815; color: #e6ebe7; border-color: #3c463f; }
    .hint { color: #a5ada7; }
    .error { color: #e08a8a; }
    .ok, .app-link { color: #7fc99a; }
  }
`;

// Wraps a page body in the shared shell. `body` is trusted markup authored in
// this directory — nothing from the request is ever interpolated here; the
// token stays in the browser and is read by the inline script from
// location.search.
export function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Kiwi</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
