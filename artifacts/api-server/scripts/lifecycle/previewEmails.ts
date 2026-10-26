// LIFE-1 + LIFE-2 — render all fourteen lifecycle emails to files, for reading
// before anything is switched on. Sends nothing, reads no database, needs no .env.
//
//   cd artifacts/api-server
//   node --import tsx scripts/lifecycle/previewEmails.ts [--out <dir>]
//
// Writes scripts/_scratch/life-1/preview/ (gitignored) unless --out names another:
//   index.html                — all fourteen side by side at 375 px and 600 px
//   1-welcome.html … 14-come_back.html, and a .txt beside each (the plain part)
//
// The sample member is "Sam"; the free-time date is the November 2 cohort's
// (D-WS9-310); next_week's plan runs out on a Friday. The unsubscribe link is
// signed with a dummy key, so it is the right shape but opts nobody out.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderLifecycleEmail } from "../../src/lib/lifecycle/render";
import { LIFECYCLE_KINDS, formatEndDate, formatPlanEndDay } from "../../src/lib/lifecycle/schedule";
import { unsubscribeUrls } from "../../src/lib/lifecycle/unsubscribe";

const here = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf("--out");
const OUT =
  outArg > 0 && process.argv[outArg + 1]
    ? path.resolve(process.argv[outArg + 1]!)
    : path.join(here, "..", "_scratch", "life-1", "preview");
mkdirSync(OUT, { recursive: true });

const SAMPLE_USER_ID = "00000000-0000-4000-8000-000000000000";
const unsub = unsubscribeUrls(SAMPLE_USER_ID, {
  JWT_SECRET: "preview-only-dummy-key",
  PUBLIC_APP_URL: "https://api.kitchenwizard.ai",
})!;
const endDate = formatEndDate(new Date("2026-11-03T04:59:59Z"), "America/New_York");
const planEndDay = formatPlanEndDay("2026-10-30");

const files: Array<{ file: string; kind: string; subject: string }> = [];
LIFECYCLE_KINDS.forEach((kind, i) => {
  const r = renderLifecycleEmail({
    kind,
    firstName: "Sam",
    endDate,
    planEndDay,
    unsubscribeUrl: kind === "welcome" ? null : unsub.page,
  });
  const base = `${i + 1}-${kind}`;
  writeFileSync(path.join(OUT, `${base}.html`), r.html);
  writeFileSync(path.join(OUT, `${base}.txt`), `Subject: ${r.subject}\nReply-To: support@kitchenwizard.ai\n\n${r.text}`);
  files.push({ file: `${base}.html`, kind, subject: r.subject });
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kiwi lifecycle emails — preview</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; background: #eee; color: #222; }
  h2 { margin: 32px 0 4px; font-size: 16px; }
  .subj { margin: 0 0 8px; color: #555; }
  .row { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  iframe { border: 1px solid #bbb; background: #fff; height: 980px; }
  .w375 { width: 375px; } .w600 { width: 600px; }
  .cap { font-size: 12px; color: #666; }
</style></head><body>
<h1>Kiwi lifecycle emails — preview</h1>
<p>Words: <code>artifacts/api-server/src/lib/lifecycle/copy.ts</code>. Re-run <code>node --import tsx scripts/lifecycle/previewEmails.ts</code> after an edit.</p>
${files
  .map(
    (f) => `<h2>${esc(f.file)} — ${esc(f.kind)}</h2>
<p class="subj">Subject: <b>${esc(f.subject)}</b> · <a href="${esc(f.file.replace(".html", ".txt"))}">plain-text part</a></p>
<div class="row"><div><div class="cap">375 px</div><iframe class="w375" src="${esc(f.file)}"></iframe></div>
<div><div class="cap">600 px</div><iframe class="w600" src="${esc(f.file)}"></iframe></div></div>`,
  )
  .join("\n")}
</body></html>
`;
writeFileSync(path.join(OUT, "index.html"), index);

console.log(`Wrote ${files.length} emails + index.html to ${OUT}`);
for (const f of files) console.log(`  ${f.file.padEnd(22)} ${f.subject}`);
