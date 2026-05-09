// WS6 6a-2 — Seed SystemSetting rows.
// Defaults from PRD §15.5.1, §15.6.4, plus model rate settings (D-WS6-007).
// Keep `value` and `defaultValue` identical at seed time — admins editing
// `value` later won't lose the original baseline.
//
// Idempotent — uses upsert on SystemSetting.key. Re-running refreshes
// `description` and `defaultValue` only; `value` is preserved if an admin
// has already changed it.

import type { PrismaClient } from "@prisma/client";

interface SettingSeed {
  key: string;
  value: unknown;
  defaultValue: unknown;
  description: string;
}

const SETTINGS: SettingSeed[] = [
  // PRD §15.5.1 — system tunables.
  {
    key: "wizard.candidate_count",
    value: 3,
    defaultValue: 3,
    description:
      "Default number of plan candidates the wizard returns per generation.",
  },
  {
    key: "wizard.max_refreshes_per_session",
    value: 3,
    defaultValue: 3,
    description:
      "Maximum number of refresh-results actions allowed per wizard session.",
  },
  {
    key: "trial.duration_days",
    value: 30,
    defaultValue: 30,
    description: "Length of the free trial in days for new signups.",
  },
  {
    key: "trial.nudge_intervals_days",
    value: [7, 3, 1],
    defaultValue: [7, 3, 1],
    description:
      "Days-before-trial-end at which trial-ending nudges are dispatched.",
  },
  {
    key: "grocery.list_retention_months",
    value: 6,
    defaultValue: 6,
    description:
      "Number of months grocery lists are retained before automatic archival.",
  },
  {
    key: "plans.free_tier_saved_cap",
    value: 4,
    defaultValue: 4,
    description: "Maximum number of saved plans on the free tier.",
  },
  {
    key: "subscription.grace_period_days",
    value: 7,
    defaultValue: 7,
    description:
      "Grace-period length in days after a subscription becomes past_due.",
  },
  {
    key: "import.image_free_tier_monthly_limit",
    value: "unlimited",
    defaultValue: "unlimited",
    description:
      "Free-tier monthly cap on recipe-image imports. 'unlimited' disables the cap.",
  },
  {
    key: "macros.high_protein_min_g_per_serving",
    value: 25,
    defaultValue: 25,
    description:
      "Minimum grams of protein per serving for the high-protein macro tag.",
  },
  {
    key: "macros.low_carb_max_g_per_serving",
    value: 30,
    defaultValue: 30,
    description:
      "Maximum grams of carbs per serving for the low-carb macro tag.",
  },
  {
    key: "macros.healthy_max_cal_per_serving",
    value: 600,
    defaultValue: 600,
    description:
      "Maximum calories per serving for the healthy macro tag.",
  },

  // PRD §15.6.4 — Top Rated tunables.
  {
    key: "top_rated.save_weight",
    value: 1.0,
    defaultValue: 1.0,
    description: "Weight applied to save events in the Top Rated score.",
  },
  {
    key: "top_rated.use_weight",
    value: 2.0,
    defaultValue: 2.0,
    description: "Weight applied to use events in the Top Rated score.",
  },
  {
    key: "top_rated.decay_half_life_days",
    value: 30,
    defaultValue: 30,
    description:
      "Half-life in days for time-decay of save/use events in the Top Rated score.",
  },
  {
    key: "top_rated.refresh_interval_hours",
    value: 6,
    defaultValue: 6,
    description: "Refresh interval in hours for the Top Rated leaderboard.",
  },
  {
    key: "top_rated.display_count",
    value: 20,
    defaultValue: 20,
    description: "Number of meals/plans shown in the Top Rated tab.",
  },

  // D-WS6-007 — model rate settings (moved from hardcoded MODEL_RATES).
  // Per-million-token published rates as of 2026-05.
  {
    key: "ai.model_rate.claude-sonnet-4-6.input_per_mtok",
    value: 3,
    defaultValue: 3,
    description: "Input USD per million tokens for claude-sonnet-4-6.",
  },
  {
    key: "ai.model_rate.claude-sonnet-4-6.output_per_mtok",
    value: 15,
    defaultValue: 15,
    description: "Output USD per million tokens for claude-sonnet-4-6.",
  },
  {
    key: "ai.model_rate.claude-haiku-4-5-20251001.input_per_mtok",
    value: 1,
    defaultValue: 1,
    description:
      "Input USD per million tokens for claude-haiku-4-5-20251001.",
  },
  {
    key: "ai.model_rate.claude-haiku-4-5-20251001.output_per_mtok",
    value: 5,
    defaultValue: 5,
    description:
      "Output USD per million tokens for claude-haiku-4-5-20251001.",
  },
];

export async function seedSystemSettings(prisma: PrismaClient): Promise<void> {
  for (const s of SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      // Refresh description + defaultValue on every run; preserve `value`
      // so an admin's runtime override survives re-seeding.
      update: {
        description: s.description,
        defaultValue: s.defaultValue as never,
      },
      create: {
        key: s.key,
        value: s.value as never,
        defaultValue: s.defaultValue as never,
        description: s.description,
      },
    });
  }

  console.log(`seeded ${SETTINGS.length} system settings`);
}
