// READ-ONLY: the playlist count the generate prompt saw for each pref set.
import { PrismaClient } from "@prisma/client";
import { resolveEffectivePreferences, discoveryLevelFromInput } from "../../../src/lib/wizardPreferences";
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("refusing");
const prisma = new PrismaClient();
const pc = await resolveEffectivePreferences(prisma, "76f9d078-830e-45ef-beb3-11474dae716e",
  { discoveryLevel: discoveryLevelFromInput({}) }, { planDurationDays: 5 });
console.log(JSON.stringify(pc));
await prisma.$disconnect();
