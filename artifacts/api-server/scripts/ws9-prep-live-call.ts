// WS9 §3 — mint a token for the plan's owner and POST the prep-week endpoint,
// so the before/after prose comparison comes from a REAL live call through the
// running dev server (not a reconstruction).
import { PrismaClient } from "@prisma/client";
import { signToken } from "../src/lib/auth";
if (!process.env.DATABASE_URL) { try { process.loadEnvFile(".env"); } catch { /* */ } }
const prisma = new PrismaClient();
const prefix = process.argv[2] ?? "3d2fdff3";
const base = process.env.BASE ?? "http://127.0.0.1:3000/api";

async function main() {
  const plan = await prisma.mealPlanInstance.findFirst({ where: { id: { startsWith: prefix } } });
  if (!plan) throw new Error("no plan");
  const token = signToken(plan.userId);
  const t0 = Date.now();
  const res = await fetch(`${base}/plans/${plan.id}/prep-week`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const elapsed = Date.now() - t0;
  const body = await res.json() as { cacheHit?: boolean; subset?: boolean; promptVersion?: number; error?: string;
    result?: { phases: { phase: string; steps: { number: number; title: string; instructions: string }[] }[] } };
  console.log(`status=${res.status} cacheHit=${body.cacheHit} subset=${body.subset} promptVersion=${body.promptVersion} wall=${(elapsed/1000).toFixed(1)}s`);
  if (body.error) { console.log(`error: ${body.error}`); return; }
  const filter = process.argv[3];
  for (const ph of body.result?.phases ?? []) {
    for (const st of ph.steps) {
      if (filter && !`${st.title} ${st.instructions}`.toLowerCase().includes(filter.toLowerCase())) continue;
      console.log(`\n── [${ph.phase}] #${st.number} ${st.title}`);
      console.log(st.instructions.split("\n").map((l) => "   " + l).join("\n"));
    }
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
