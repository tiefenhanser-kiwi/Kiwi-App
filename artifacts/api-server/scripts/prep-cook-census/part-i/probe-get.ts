// [prepcook] Part I — probe: the shape GET /plans/:id returns. Read-only.
import express from "express";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { signToken } from "../../../src/lib/auth";
import { createPlansRouter } from "../../../src/routes/plans";
import { TEST_USER_ID } from "./corpus";

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use("/api", createPlansRouter({ prisma }));
const server: Server = app.listen(0, async () => {
  const a = server.address();
  const port = typeof a === "object" && a ? a.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/plans/${process.argv[2]}`, { headers: { authorization: `Bearer ${signToken(TEST_USER_ID)}` } });
  const j = (await res.json()) as Record<string, unknown>;
  console.log(res.status, Object.keys(j));
  const plan = (j.plan ?? j) as Record<string, unknown>;
  console.log(Object.keys(plan));
  const items = (plan.items ?? []) as Record<string, unknown>[];
  console.log(items.map((i) => ({ mealId: String(i.mealId).slice(0, 8), isPrepped: i.isPrepped })));
  server.close();
  await prisma.$disconnect();
});
