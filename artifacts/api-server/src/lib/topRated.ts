// WS7-3 A2 — Top Rated scoring (PRD §15.6.4).
//
// Score = (saveCount * saveWeight + useCount * useWeight) decayed by an
// exponential half-life on the days since the last interaction. "Last
// interaction" is proxied by MealPlanTemplate.updatedAt — Prisma bumps it on
// any row update, so a non-counter field write skews the decay slightly.
// Acceptable for MVP (flagged in the WS7-3 A2 Phase 3 report §4).
//
// recomputeAndPersistTopRated ships as a callable helper ONLY. WS7-4
// (plan-mutation) and WS7-5 (wizard save-commit) wire it to their counter
// write sites — A2 does NOT invoke it at any trigger site.

import type { PrismaClient } from "@prisma/client";

export interface TopRatedSettings {
  saveWeight: number;
  useWeight: number;
  decayHalfLifeDays: number;
  refreshIntervalHours: number;
  displayCount: number;
}

// PRD §15.6.4 defaults — mirror prisma/seeds/systemSettings.ts. Used as the
// per-key fallback when a SystemSetting row is missing or non-numeric so
// scoring never throws.
export const TOP_RATED_DEFAULTS: TopRatedSettings = {
  saveWeight: 1.0,
  useWeight: 2.0,
  decayHalfLifeDays: 30,
  refreshIntervalHours: 6,
  displayCount: 20,
};

const SETTING_KEYS = {
  saveWeight: "top_rated.save_weight",
  useWeight: "top_rated.use_weight",
  decayHalfLifeDays: "top_rated.decay_half_life_days",
  refreshIntervalHours: "top_rated.refresh_interval_hours",
  displayCount: "top_rated.display_count",
} as const;

// Minimal structural type so tests can inject a stub without the full client.
type SystemSettingReader = {
  systemSetting: {
    findMany: (args: {
      where: { key: { in: string[] } };
    }) => Promise<{ key: string; value: unknown }[]>;
  };
};

// Reads the five top_rated.* SystemSettings. Generalizes the getModelRate
// reader pattern (promptRegistry.ts): a direct findMany with a per-key
// fallback to PRD defaults on a missing/non-numeric row or a failed read.
// No caching — callers read once per request.
export async function getTopRatedSettings(
  prisma: SystemSettingReader,
): Promise<TopRatedSettings> {
  const keys = Object.values(SETTING_KEYS);
  let rows: { key: string; value: unknown }[] = [];
  try {
    rows = await prisma.systemSetting.findMany({
      where: { key: { in: keys } },
    });
  } catch {
    return { ...TOP_RATED_DEFAULTS };
  }
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string, fallback: number): number => {
    const raw = byKey.get(key);
    if (raw === undefined || raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    saveWeight: num(SETTING_KEYS.saveWeight, TOP_RATED_DEFAULTS.saveWeight),
    useWeight: num(SETTING_KEYS.useWeight, TOP_RATED_DEFAULTS.useWeight),
    decayHalfLifeDays: num(
      SETTING_KEYS.decayHalfLifeDays,
      TOP_RATED_DEFAULTS.decayHalfLifeDays,
    ),
    refreshIntervalHours: num(
      SETTING_KEYS.refreshIntervalHours,
      TOP_RATED_DEFAULTS.refreshIntervalHours,
    ),
    displayCount: num(
      SETTING_KEYS.displayCount,
      TOP_RATED_DEFAULTS.displayCount,
    ),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Pure scoring function. Zero counters → zero score. The base score decays by
// half every `decayHalfLifeDays` since `updatedAt`.
export function computeTopRatedScore(
  template: { saveCount: number; useCount: number; updatedAt: Date },
  settings: TopRatedSettings,
  now: Date,
): number {
  const base =
    template.saveCount * settings.saveWeight +
    template.useCount * settings.useWeight;
  if (base === 0) return 0;
  const daysSince = Math.max(
    0,
    (now.getTime() - template.updatedAt.getTime()) / MS_PER_DAY,
  );
  // Guard against a misconfigured non-positive half-life.
  const halfLife =
    settings.decayHalfLifeDays > 0 ? settings.decayHalfLifeDays : 1;
  const decay = Math.pow(0.5, daysSince / halfLife);
  return base * decay;
}

// Callable compute-on-write helper. Reads the template, computes the score,
// persists topRatedScore + topRatedScoreUpdatedAt. Returns the new score, or
// null when the template does not exist. NOT invoked anywhere in A2 — WS7-4 /
// WS7-5 wire the call sites at their counter-write surfaces.
export async function recomputeAndPersistTopRated(
  prisma: PrismaClient,
  templateId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const template = await prisma.mealPlanTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, saveCount: true, useCount: true, updatedAt: true },
  });
  if (!template) return null;
  const settings = await getTopRatedSettings(prisma);
  const score = computeTopRatedScore(template, settings, now);
  await prisma.mealPlanTemplate.update({
    where: { id: templateId },
    data: { topRatedScore: score, topRatedScoreUpdatedAt: now },
  });
  return score;
}
