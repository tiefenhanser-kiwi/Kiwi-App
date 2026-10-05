// [prepcook] Part J.1c BUG-354 — READ-ONLY: how long dish titles run, and whether
// the short display title (D-WS9-121) is there to fall back on.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.$queryRaw<{ n: bigint; over60: bigint; over80: bigint; over100: bigint; maxlen: number; withShort: bigint; longWithShort: bigint }[]>`
    SELECT count(*) n,
           count(*) FILTER (WHERE length(title) > 60) over60,
           count(*) FILTER (WHERE length(title) > 80) over80,
           count(*) FILTER (WHERE length(title) > 100) over100,
           max(length(title)) maxlen,
           count("displayTitle") "withShort",
           count("displayTitle") FILTER (WHERE length(title) > 60) "longWithShort"
    FROM dishes`;
  console.log(rows[0]);
  const top = await prisma.$queryRaw<{ title: string; displayTitle: string | null }[]>`SELECT title, "displayTitle" FROM dishes ORDER BY length(title) DESC LIMIT 5`;
  for (const t of top) console.log(`${t.title.length}  ${t.title}  →  ${t.displayTitle ?? "-"}`);
}
main().finally(() => prisma.$disconnect());
