// Part J.0 — read-only: which AIPrompt rows the prompts-only seed would change.
import { PrismaClient } from "@prisma/client";
import * as seedNs from "../../../prisma/seeds/aiPrompts";
const prisma = new PrismaClient();
(async () => {
  // PROMPTS is not exported; capture it by running the seed against a recording stub.
  const rec: { key: string; model: string; body: string }[] = [];
  const stub: any = {
    aIPrompt: { upsert: async (a: any) => { rec.push({ key: a.where.key, model: a.update.defaultModel, body: "" }); return { id: a.where.key }; }, deleteMany: async () => ({ count: 0 }) },
    aIPromptVersion: {
      findFirst: async (a: any) => null,
      aggregate: async () => ({ _max: { version: 0 } }),
      updateMany: async () => ({}), create: async (a: any) => { rec.find((r) => r.key === a.data.promptId)!.body = a.data.body; return {}; },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  await (seedNs as any).seedAIPrompts(stub);
  for (const r of rec) {
    const row = await prisma.aIPrompt.findUnique({ where: { key: r.key }, select: { id: true, defaultModel: true } });
    const active = row ? await prisma.aIPromptVersion.findFirst({ where: { promptId: row.id, isActive: true }, select: { version: true, body: true } }) : null;
    const modelChange = row?.defaultModel !== r.model;
    const bodyChange = active?.body !== r.body;
    if (modelChange || bodyChange) console.log(`${r.key}: model ${row?.defaultModel} -> ${r.model}${modelChange ? " *" : ""} · body ${bodyChange ? `CHANGES (v${active?.version} -> v${(active?.version ?? 0) + 1})` : "same"}`);
  }
})().finally(() => prisma.$disconnect());
