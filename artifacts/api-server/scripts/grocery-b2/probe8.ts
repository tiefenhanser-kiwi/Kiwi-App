import { PrismaClient } from "@prisma/client";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
const prisma = new PrismaClient();
const idx = await loadRelationIndex(prisma);
for (const c of idx.clusters) {
  if (c.members.some((m) => /parsley|cheddar|bell pepper|chicken thigh/.test(m))) {
    console.log(`rep="${c.representative}"  members: ${c.members.join(" | ")}`);
  }
}
await prisma.$disconnect();
