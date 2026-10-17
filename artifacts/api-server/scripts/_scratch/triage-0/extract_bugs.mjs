// TRIAGE-0, read-only: pull listed BUG / D-WS9 entries from the canon mirror
// into per-ID files in the session scratchpad. Usage: node extract_bugs.mjs <outDir> 058 103 D-WS9-315 ...
import fs from "node:fs";
const dir = "C:/Cooking App/kiwi-canon/";
const files = [
  "kiwi_bug_log.md",
  "kiwi_bug_log_ARCHIVE_2026-09-17.md",
  "kiwi_bug_log_ARCHIVE_2026-09-12.md",
  "kiwi_deferred_decisions_log.md",
];
const [out, ...ids] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const texts = files.map((f) => [f, fs.readFileSync(dir + f, "utf8").split(/\r?\n/)]);
for (const raw of ids) {
  const id = raw.startsWith("D-") ? raw : "BUG-" + raw;
  const head = new RegExp("^#{2,4}\\s+(?:\\S+\\s+)?" + id + "(?!\\d)");
  const chunks = [];
  for (const [f, lines] of texts) {
    for (let i = 0; i < lines.length; i++) {
      if (head.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
        chunks.push(`<<< ${f}:${i + 1} >>>\n` + lines.slice(i, j).join("\n"));
      }
    }
  }
  fs.writeFileSync(`${out}/${id}.md`, chunks.join("\n\n"));
  console.log(id, chunks.length, chunks.map((c) => c.length).join(","));
}
