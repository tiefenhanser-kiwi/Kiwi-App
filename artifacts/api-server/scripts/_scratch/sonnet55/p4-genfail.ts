// READ-ONLY: set_preferences.generate outcomes by mode + prompt version, last 30d
// (stream = text mode, buffered fallback = tool mode). Excludes this lane's rows
// (userId null).
import { PrismaClient } from "@prisma/client";
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("refusing");
const prisma = new PrismaClient();
const g = await prisma.lLMCallLog.groupBy({
  by: ["mode", "promptVersion", "success", "failureReason"],
  where: { promptKey: "wizard.set_preferences.generate", createdAt: { gte: new Date(Date.now() - 30 * 864e5) }, userId: { not: null } },
  _count: { _all: true },
  _avg: { outputTokens: true, latencyMs: true },
});
for (const r of g.sort((a, b) => (b.promptVersion ?? 0) - (a.promptVersion ?? 0)))
  console.log(r.mode, "v" + r.promptVersion, r.success ? "OK  " : "FAIL", r.failureReason ?? "", "n=" + r._count._all, "out=" + Math.round(r._avg.outputTokens ?? 0), "lat=" + Math.round(r._avg.latencyMs ?? 0));
await prisma.$disconnect();
