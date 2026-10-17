// TRIAGE-0 — interactive walk driver (dev only). Connects over CDP to a headless
// Chromium already running on :9333, acts on its one page, and disconnects, so
// the session survives between steps. Screenshots + rendered text land in
// artifacts/kiwi/e2e/out/triage0-walk/ (gitignored).
//
//   node drive.cjs goto <path>            navigate (relative to :9000)
//   node drive.cjs shot <name>            full-page png + txt
//   node drive.cjs text                   print rendered leaf text
//   node drive.cjs click <text|/re/> [n]  click nth visible focusable/role match
//   node drive.cjs fill <placeholder> <value|@secret:key>
//   node drive.cjs eval <js>              page.evaluate
//   node drive.cjs wait <ms>              settle up to ms
//   node drive.cjs net <ms>               log /api calls (status, ms) for ms while idle
//
// Secrets: "@secret:key" reads key from the scratchpad secrets json and is never
// echoed. Output text is swept by redact() before printing or writing.
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(path.resolve(__dirname, "../../../../kiwi/node_modules/@playwright/test"));

const OUT = path.resolve(__dirname, "../../../../kiwi/e2e/out/triage0-walk");
const SECRETS = process.env.TRIAGE0_SECRETS;
const ORIGIN = "http://localhost:9000";
fs.mkdirSync(OUT, { recursive: true });

function secrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS, "utf8")); } catch { return {}; }
}
function redact(t) {
  let s = String(t);
  for (const v of Object.values(secrets())) if (v && String(v).length > 3) s = s.split(String(v)).join("«redacted»");
  return s;
}

async function leafText(page) {
  return page.evaluate(() => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement; if (!el || el.tagName === "STYLE" || el.tagName === "SCRIPT" || el.tagName === "NOSCRIPT") continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return out;
  });
}
async function settle(page, ms = 30000) {
  const end = Date.now() + ms; let last = ""; let same = 0;
  while (Date.now() < end) {
    const j = (await leafText(page)).join("|");
    if (j === last) { if (++same >= 3) return; } else { same = 0; last = j; }
    await page.waitForTimeout(500);
  }
}

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().startsWith(ORIGIN)) || ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 375, height: 812 });
  const t0 = Date.now();
  try {
    if (process.env.TRIAGE0_NET) {
      page.on("response", (r) => {
        if (r.url().includes("/api/") && r.request().method() !== "GET") console.log(`NET ${r.status()} ${r.request().method()} ${r.url().replace(ORIGIN, "").slice(0, 120)}`);
      });
    }
    if (cmd === "goto") {
      await page.goto(ORIGIN + a1, { waitUntil: "domcontentloaded" });
      await settle(page, Number(a2 || 30000));
    } else if (cmd === "shot") {
      await settle(page, 15000);
      await page.screenshot({ path: path.join(OUT, a1 + ".png"), fullPage: true });
      const txt = redact((await leafText(page)).join("\n"));
      fs.writeFileSync(path.join(OUT, a1 + ".txt"), txt, "utf8");
      console.log(`shot ${a1} @ ${page.url()}`);
      console.log(txt);
    } else if (cmd === "scrollshot") {
      // RNW scrolls inside a div, so fullPage stops at the viewport: page the
      // largest visible scroller and shoot each screenful (max a2 pages).
      await settle(page, 15000);
      const max = Number(a2 || 6);
      for (let i = 0; i < max; i++) {
        const done = await page.evaluate((step) => {
          const els = [...document.querySelectorAll("div")].filter((d) => {
            const s = getComputedStyle(d);
            return /(auto|scroll)/.test(s.overflowY) && d.scrollHeight > d.clientHeight + 4 && d.getBoundingClientRect().width > 300 && d.offsetParent !== null;
          });
          els.sort((a, b) => b.clientHeight - a.clientHeight);
          const el = els[0];
          if (!el) return true;
          if (step === 0) { el.scrollTop = 0; return false; }
          const before = el.scrollTop;
          el.scrollTop = before + el.clientHeight * 0.85;
          return el.scrollTop === before;
        }, i);
        if (done && i > 0) break;
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT, `${a1}-p${i + 1}.png`) });
        console.log(`${a1}-p${i + 1}.png`);
      }
      fs.writeFileSync(path.join(OUT, a1 + ".txt"), redact((await leafText(page)).join("\n")), "utf8");
    } else if (cmd === "text") {
      console.log(page.url()); console.log(redact((await leafText(page)).join("\n")));
    } else if (cmd === "click") {
      const n = Number(a2 || 0);
      const re = a1.startsWith("/") ? new RegExp(a1.slice(1, a1.lastIndexOf("/")), a1.slice(a1.lastIndexOf("/") + 1)) : new RegExp("^\\s*" + a1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$");
      let loc = page.locator('[role="button"],[role="tab"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],a,button,[tabindex="0"]').filter({ hasText: re });
      let c = await loc.count();
      if (c === 0) { loc = page.getByText(re); c = await loc.count(); }
      console.log(`matches: ${c}`);
      await loc.nth(n).click({ timeout: 15000 });
      await settle(page, 20000);
    } else if (cmd === "clicksel") {
      const loc = page.locator(a1);
      console.log(`matches: ${await loc.count()}`);
      await loc.nth(Number(a2 || 0)).click({ timeout: 15000 });
      await settle(page, 15000);
    } else if (cmd === "type") {
      await page.keyboard.type(a1);
    } else if (cmd === "fill") {
      const s = secrets();
      const v = a2.startsWith("@secret:") ? s[a2.slice(8)] : a2;
      await page.getByPlaceholder(a1).first().fill(String(v));
    } else if (cmd === "eval") {
      console.log(redact(JSON.stringify(await page.evaluate(a1), null, 1)));
    } else if (cmd === "wait") {
      await settle(page, Number(a1 || 30000));
    } else if (cmd === "net") {
      const log = [];
      page.on("response", (r) => { if (r.url().includes("/api/")) log.push(`${r.status()} ${r.request().method()} ${r.url().replace(ORIGIN, "")}`); });
      await page.waitForTimeout(Number(a1 || 5000));
      console.log(log.join("\n"));
    }
  } catch (e) {
    console.log("ERROR " + redact(e.message).slice(0, 800));
  }
  console.log(`[${cmd} ${((Date.now() - t0) / 1000).toFixed(1)}s] url=${page.url().slice(0, 110)}`);
  await browser.close();
})();
