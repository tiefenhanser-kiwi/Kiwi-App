// SERVER-6 B (D-WS9-325) — the `retailer.shop_your_store_enabled` flag.
//
// The same shape as instacartFlag.ts: a factory, one 60 s window per router
// instance, and it fails CLOSED (readBooleanSetting never throws; a missing
// row, a bad value or a database error all read false). Seeded false, so
// Shop Your Store is off until Hans flips the row — no deploy, no app update.

import type { PrismaClient } from "@prisma/client";

import { createCachedSettingReader, readBooleanSetting } from "../systemSettings";

export const SHOP_YOUR_STORE_ENABLED_SETTING_KEY = "retailer.shop_your_store_enabled";

type SettingsClient = Pick<PrismaClient, "systemSetting">;

/** A 60 s-cached reader of the Shop Your Store flag for one router instance. */
export function createShopYourStoreEnabledReader(
  prisma: SettingsClient,
): () => Promise<boolean> {
  return createCachedSettingReader(() =>
    readBooleanSetting(prisma, SHOP_YOUR_STORE_ENABLED_SETTING_KEY, false),
  );
}
