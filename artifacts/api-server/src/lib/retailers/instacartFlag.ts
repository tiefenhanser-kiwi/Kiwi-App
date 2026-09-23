// The `retailer.instacart_enabled` flag — ONE reader, two consumers.
//
// Row 8 Block 1 built this as a closure inside createGroceryListsRouter so the
// grocery-list detail GET could gate the Instacart CTA. The store-prep lane
// added a second consumer — GET /home, which the phone reads to decide whether
// the "Order Online" cell renders on Plan Review at all — so the key, the
// fallback and the cache window moved here instead of being retyped.
//
// Deliberately a FACTORY, one window per call, NOT a module-global cache keyed
// on the client: systemSettings.ts's own docblock says the per-consumer window
// exists because "tests build a router per case and must never see a stale flag
// from the previous one". Sharing one cache across both routers would trade
// that isolation for a saved query every 60 s. So: one implementation, one key,
// one TTL — each router instance still owns its own window.
//
// Fails CLOSED. readBooleanSetting never throws: a missing row, a bad value or
// a database error all yield `false`, so the flag cannot take a route down and
// cannot accidentally expose the retailer surface.

import type { PrismaClient } from "@prisma/client";

import { createCachedSettingReader, readBooleanSetting } from "../systemSettings";

export const INSTACART_ENABLED_SETTING_KEY = "retailer.instacart_enabled";

type SettingsClient = Pick<PrismaClient, "systemSetting">;

/** A 60 s-cached reader of the Instacart flag for one router instance. */
export function createInstacartEnabledReader(
  prisma: SettingsClient,
): () => Promise<boolean> {
  return createCachedSettingReader(() =>
    readBooleanSetting(prisma, INSTACART_ENABLED_SETTING_KEY, false),
  );
}
