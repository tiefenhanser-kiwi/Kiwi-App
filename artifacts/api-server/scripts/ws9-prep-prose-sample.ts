// WS9 §3 — READ-ONLY: dump the narrated prose from a plan's cached prep structure,
// so a before/after comparison of the prompt edit quotes REAL output.
import { PrismaClient } from "@prisma/client";
if (!process.env.DATABASE_URL) { try { process.loadEnvFile(".env"); } catch { /* */ } }
const prisma = new PrismaClient();
const prefix = process.argv[2] ?? "3d2fdff3";
const filter = process.argv[3];

async function main() {
  const plan = await prisma.mealPlanInstance.findFirst({ where: { id: { startsWith: prefix } } });
  if (!plan) throw new Error("no plan");
  const row = await prisma.prepWeekStructure.findUnique({ where: { planId: plan.id } });
  if (!row) { console.log("no cache row"); return; }
  console.log(`plan ${plan.id}  promptVersion=${row.promptVersion}  generatedAt=${row.lastGeneratedAt.toISOString()}`);
  console.log(`compositionFingerprint=${row.compositionFingerprint ?? "(null)"}\n`);
  const s = row.structureJson as unknown as {
    phases: { phase: string; steps: { number: number; title: string; instructions: string }[] }[];
  };
  for (const ph of s.phases) {
    for (const st of ph.steps) {
      if (filter && !`${st.title} ${st.instructions}`.toLowerCase().includes(filter.toLowerCase())) continue;
      console.log(`── [${ph.phase}] #${st.number} ${st.title}`);
      console.log(st.instructions.split("\n").map((l) => "   " + l).join("\n"));
      console.log("");
    }
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
