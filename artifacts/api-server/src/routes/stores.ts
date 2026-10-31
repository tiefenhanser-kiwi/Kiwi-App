// SHOP-1 (D-WS9-325) — GET /stores: the Shop Your Store registry, ranked for the
// cook's state.
//
//   GET /stores?state=MA  → the stores that serve Massachusetts, most stores there
//                            first (lib/retailers/stores.ts, storesForState).
//   GET /stores           → every store, most stores nationally first.
//
// The client passes the state; how the app learns it (the sign-up IP, a one-tap
// confirm) is the CLIENT lane's. A state Kiwi does not know is a 400, never a
// silent national list: the client sent something, and it is wrong.
//
// Behind `retailer.shop_your_store_enabled`, the same fail-closed reader as the
// grocery detail read: off (no row, a bad value, a database error) answers
// enabled false and NO stores, so nothing can render before release #7 flips it.
// `storesVersion` rides every answer, on or off, so the client can cache the list
// and tell when the registry moved.
//
// Members only (requireAuth refuses a guest token). No rate limit: the answer is a
// constant read from memory, after the one cached flag read.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { createShopYourStoreEnabledReader } from "../lib/retailers/shopYourStoreFlag";
import {
  parseUsState,
  SHOP_YOUR_STORE_DISCLOSURE,
  storesForState,
  STORES_VERSION,
  toStoreWire,
} from "../lib/retailers/stores";
import { createRequireAuth } from "../middleware/auth";

export interface StoresRouterDeps {
  prisma: PrismaClient;
}

export function createStoresRouter(deps: Partial<StoresRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const requireAuth = createRequireAuth({ prisma });
  const getShopYourStoreEnabled = createShopYourStoreEnabledReader(prisma);
  const router: IRouter = Router();

  router.get("/stores", requireAuth, async (req, res) => {
    const raw = req.query.state;
    const state = raw === undefined || raw === "" ? null : parseUsState(raw);
    if (state === undefined) {
      return res.status(400).json({ error: "invalid state", message: "state must be a two-letter US state code, like MA" });
    }
    try {
      const enabled = await getShopYourStoreEnabled();
      return res.status(200).json({
        enabled,
        storesVersion: STORES_VERSION,
        state,
        stores: enabled ? storesForState(state).map((st) => toStoreWire(st, state)) : [],
        disclosure: SHOP_YOUR_STORE_DISCLOSURE,
      });
    } catch (err) {
      logger.error({ event: "get_stores_failed", userId: req.userId, err }, "GET /stores failed");
      return res.status(500).json({ error: "internal server error" });
    }
  });

  return router;
}

const storesRouter: IRouter = createStoresRouter();
export default storesRouter;
