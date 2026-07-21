// WS7-6 G2 — Dish Builder Mode A: parse a free-text dish description into a
// structured single Dish record (ingredients + phase-tagged steps + meta).
//
// The dish twin of mealBuilder.ts (Mode A meal parsing). PRD §10.5.8 frames
// dishes as working "the same way" as meals, including type-in-text. Premium
// per PRD §1.2 (entitlement key: meal_builder_text_input) — the gate lives in
// the route layer (routes/builder.ts); this helper is gate-agnostic so smoke /
// batch callers can exercise it without entitlement plumbing.
//
// Server-only. No DB writes. No activity events. Mirrors mealBuilder.ts
// exactly except the prompt key + the single-dish (no sub-dishes) result.

import Anthropic from "@anthropic-ai/sdk";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import type { PrismaLike } from "./ai/promptRegistry";
import {
  ParseDishResultSchema,
  type ParseDishInput,
  type ParsedDish,
} from "./ai/schemas/mealBuilder";

export interface ParseDishFromTextOptions {
  prisma: PrismaLike;
  userId: string;
  // DI seam for tests. Production callers omit and runAICall builds its own
  // module-level Anthropic client from process.env.ANTHROPIC_API_KEY.
  client?: Pick<Anthropic, "messages">;
  freeText: string;
  servings: number;
  userHints?: ParseDishInput["userHints"];
}

export type ParseDishFromTextResult =
  | {
      status: "success";
      dish: ParsedDish;
      caveats?: string[];
    }
  | {
      status: "failed";
      error: string;
    };

/**
 * Invokes the `dish_builder.mode_a_parse` AI prompt. Returns the parsed Dish
 * record or a soft failure ({ status: 'failed', error }) — does NOT throw on
 * AI / validation errors so the route layer can surface a user-readable
 * message. Throws only on programmer-error paths (e.g. unknown prompt key,
 * which would mean a deployment is out of sync — let it bubble).
 */
export async function parseDishFromText(
  opts: ParseDishFromTextOptions,
): Promise<ParseDishFromTextResult> {
  const result = await productionRunAICall(
    "dish_builder.mode_a_parse",
    {
      parseDishInput: {
        freeText: opts.freeText,
        servings: opts.servings,
        userHints: opts.userHints,
      },
    },
    ParseDishResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
      // D-WS9-053 §2.2 — temp 0: parsing free-text into structured ingredients/
      // quantities is faithful extraction, not creative generation.
      temperature: 0,
    },
  );

  if (!result.success) {
    return { status: "failed", error: result.userFacingMessage };
  }

  return {
    status: "success",
    dish: result.data.dish,
    caveats: result.data.caveats,
  };
}
