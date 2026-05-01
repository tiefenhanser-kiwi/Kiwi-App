import { Router, type IRouter } from "express";
import { z } from "zod";

import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

const FILTER_KEYS = ["my_plans", "featured", "top_rated", "hosting_events"] as const;
const MEALS_FILTER_KEYS = ["my_meals", "all_meals"] as const;

const uiStateSchema = z.object({
  lastPlanDiscoveryFilters: z.array(z.enum(FILTER_KEYS)).optional(),
  lastPlansFilters: z.array(z.enum(FILTER_KEYS)).optional(),
  lastMealsFilters: z.array(z.enum(MEALS_FILTER_KEYS)).optional(),
  // At-least-one-field requirement is enforced below by the runtime
  // Object.keys length check, so Zod's .optional() on every field is
  // intentional.
});

const router: IRouter = Router();

// PATCH /me/ui-state
router.patch("/me/ui-state", requireAuth, async (req, res) => {
  const parsed = uiStateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid body",
      details: parsed.error.flatten(),
    });
  }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "no fields to update" });
  }

  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: updates,
    });
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err, userId: req.userId }, "PATCH /me/ui-state failed");
    return res.status(500).json({ error: "failed to update ui state" });
  }
});

export default router;
