// R3-0 — the prompts-and-settings seed. The ONLY seed that may run on
// production.
//
//   pnpm --filter @workspace/api-server prisma:seed:prompts
//
// prisma/seed.ts also upserts the seed recipes' ingredients, meals, dishes and
// steps — and deleteMany's their dish ingredients and steps before recreating
// them — which on production would rewrite catalog rows the data applies
// fixed. This runs the two seeders that are diff-driven and nothing else:
//   seedAIPrompts       a new version only when the active body differs; also
//                       sweeps RETIRED_KEYS
//   seedSystemSettings  creates missing keys; an existing row keeps its value
//
// Guarded like the data scripts: dev, or production via KIWI_PRODUCTION_HOST
// (src/lib/scripts/requireDatabaseHost.ts).

import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../src/lib/scripts/requireDatabaseHost";
import { seedAIPrompts } from "./seeds/aiPrompts";
import { seedSystemSettings } from "./seeds/systemSettings";

export async function seedPromptsAndSettings(prisma: PrismaClient): Promise<void> {
  await seedAIPrompts(prisma);
  await seedSystemSettings(prisma);
}

async function main(): Promise<void> {
  assertScriptDatabase("seedPrompts");
  const prisma = new PrismaClient();
  try {
    await seedPromptsAndSettings(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Exact entry-point check: a test importing this module must never seed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
