// QA-NIGHT-1 — the night run's same-origin web server: serves the night's own web
// export and proxies /api to the night's own api-server.
//
// Not kiwi-local-tools/serve-proxy.cjs: that one hard-codes the upstream to
// :3000 (Hans's dev server) and the folder to artifacts/kiwi/dist, and the night
// run touches neither. Started and killed by scripts/qa-night/run.ts.
//   KIWI_QA_WEB_PORT (9410) · KIWI_QA_API_PORT (3100) · KIWI_QA_DIST (the export folder)
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_PORT = Number(process.env.KIWI_QA_WEB_PORT || 9410);
const API_PORT = Number(process.env.KIWI_QA_API_PORT || 3100);
const DIST = process.env.KIWI_QA_DIST;
if (!DIST || !fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`nightProxy: no index.html under KIWI_QA_DIST (${DIST})`);
  process.exit(1);
}
if (API_PORT === 3000) {
  console.error("nightProxy: refusing to proxy to :3000 (Hans's dev server)");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};

function handle(req, res) {
  if (req.url.startsWith("/api")) {
    const up = http.request(
      { host: "127.0.0.1", port: API_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${API_PORT}` } },
      (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy error: ${e.message}`);
    });
    req.pipe(up);
    return;
  }
  const clean = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(DIST, clean);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const html = `${file.replace(/[\\/]$/, "")}.html`;
    file = fs.existsSync(html) ? html : path.join(DIST, "index.html");
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

// Loopback only, both stacks: `localhost` resolves to ::1 first on some Windows setups.
http.createServer(handle).listen(WEB_PORT, "127.0.0.1");
http.createServer(handle).listen(WEB_PORT, "::1").on("error", () => {});
