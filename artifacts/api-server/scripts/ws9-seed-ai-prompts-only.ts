// WS9 §3 — run ONLY seedAIPrompts, not the full prisma/seed.ts.
//
// prisma/seed.ts also re-upserts dev meals/dishes (deleteMany + recreate on
// dishIngredient / recipeInstructionStep), which would churn the composition of
// the live plan being used for the before/after prose comparison — and bump the
// very revisionIds this block is about. The prompt-body change needs the prompt
// seed and nothing else. Version bumping stays diff-driven inside seedAIPrompts.
import { PrismaClient } from "@prisma/client";
import { seedAIPrompts } from "../prisma/seeds/aiPrompts";
if (!process.env.DATABASE_URL) { try { process.loadEnvFile(".env"); } catch { /* */ } }
const prisma = new PrismaClient();
seedAIPrompts(prisma)
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
