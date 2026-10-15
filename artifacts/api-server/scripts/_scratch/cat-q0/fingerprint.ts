// CAT-Q0 — is the dev catalog the production catalog? READ-ONLY (findMany only).
// Prints the count of public non-archived catalog meals, a SHA-256 over their
// sorted `id:updatedAt` (ISO), one over the ids alone, and one over every
// meal's exact Pass 2 review payload. updatedAt can differ for the same recipe
// (a re-stamp touches it), so the payload hash is the one that decides: equal
// ⇒ a dev full run reviews byte-identical recipes to production's.
//
//   dev:        node --env-file=.env --import tsx scripts/_scratch/cat-q0/fingerprint.ts
//   production: (fresh PowerShell window — DATABASE_URL and KIWI_PRODUCTION_HOST
//               in the shell, never in .env; the shell's DATABASE_URL wins over
//               --env-file)
//     $env:DATABASE_URL = "<production url>"
//     $env:KIWI_PRODUCTION_HOST = "<production hostname, exact>"
//     node --env-file=.env --import tsx scripts/_scratch/cat-q0/fingerprint.ts
//     Remove-Item Env:DATABASE_URL, Env:KIWI_PRODUCTION_HOST
//
// --list prints every id:updatedAt and id:payload-hash line too (to diff two runs by hand).
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { CATALOG_WHERE, loadCatalog } from "./catalogDb";
import { userMessage } from "./rubric";

const { host, mode } = assertScriptDatabase("cat-q0/fingerprint");
const prisma = new PrismaClient();
const rows = await prisma.meal.findMany({ where: CATALOG_WHERE, select: { id: true, updatedAt: true } });
const prisma2 = prisma;
const lines = rows.map((r) => `${r.id}:${r.updatedAt.toISOString()}`).sort();
const sha = createHash("sha256").update(lines.join("\n")).digest("hex");
// The ids alone too: the same meals with different edits vs a different set.
const idSha = createHash("sha256").update(rows.map((r) => r.id).sort().join("\n")).digest("hex");
console.log(`database ${host} (${mode})`);
console.log(`catalog meals (isPublic, !isArchived): ${rows.length}`);
console.log(`sha256(sorted id:updatedAt) ${sha}`);
console.log(`sha256(sorted id)           ${idSha}`);
console.log(`latest updatedAt            ${lines.length ? rows.reduce((a, r) => (r.updatedAt > a ? r.updatedAt : a), rows[0].updatedAt).toISOString() : "-"}`);
if (process.argv.includes("--list")) for (const l of lines) console.log(l);
// What Pass 2 actually reviews: a hash over each meal's exact review payload.
// Equal here ⇒ a dev run reviews byte-identical recipes to production's.
const full = await loadCatalog(prisma2);
await prisma2.$disconnect();
const per = full.map((m) => `${m.id}:${createHash("sha256").update(userMessage(m)).digest("hex")}`).sort();
console.log(`sha256(review payloads)     ${createHash("sha256").update(per.join("\n")).digest("hex")}`);
if (process.argv.includes("--list")) for (const l of per) console.log(`payload ${l}`);
