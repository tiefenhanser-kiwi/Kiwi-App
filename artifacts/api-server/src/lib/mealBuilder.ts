// WS6 6b-5 — Meal Builder Mode A: parse a free-text meal description into a
// structured Meal record with one or more sub-dishes.
//
// PRD §1.2 frames Mode A as PREMIUM (entitlement key:
// meal_builder_text_input) — distinct from the Kiwi-assist checkboxes in
// kiwiAssist.ts which are FREE. The premium gate lives in the route layer
// (routes/builder.ts); this helper is gate-agnostic so smoke / batch
// callers can exercise it without entitlement plumbing.
//
// Server-only. No DB writes. No activity events. Caller wires those when
// the Mode A form ships (WS7 or a sibling sub-phase).

import Anthropic from "@anthropic-ai/sdk";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import type { PrismaLike } from "./ai/promptRegistry";
import {
  ParseMealResultSchema,
  type ParseMealInput,
  type ParsedMeal,
} from "./ai/schemas/mealBuilder";

export interface ParseMealFromTextOptions {
  prisma: PrismaLike;
  userId: string;
  // DI seam for tests. Production callers omit and runAICall builds its own
  // module-level Anthropic client from process.env.ANTHROPIC_API_KEY.
  client?: Pick<Anthropic, "messages">;
  freeText: string;
  servings: number;
  userHints?: ParseMealInput["userHints"];
}

export type ParseMealFromTextResult =
  | {
      status: "success";
      meal: ParsedMeal;
      caveats?: string[];
    }
  | {
      status: "failed";
      error: string;
    };

/**
 * Invokes the `meal_builder.mode_a_parse` AI prompt. Returns the parsed Meal
 * record or a soft failure ({ status: 'failed', error }) — does NOT throw on
 * AI / validation errors so the route layer can surface a user-readable
 * message. Throws only on programmer-error paths (e.g. unknown prompt key,
 * which would mean a deployment is out of sync — let it bubble).
 */
export async function parseMealFromText(
  opts: ParseMealFromTextOptions,
): Promise<ParseMealFromTextResult> {
  const result = await productionRunAICall(
    "meal_builder.mode_a_parse",
    {
      parseMealInput: {
        freeText: opts.freeText,
        servings: opts.servings,
        userHints: opts.userHints,
      },
    },
    ParseMealResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );

  if (!result.success) {
    return { status: "failed", error: result.userFacingMessage };
  }

  return {
    status: "success",
    meal: result.data.meal,
    caveats: result.data.caveats,
  };
}
