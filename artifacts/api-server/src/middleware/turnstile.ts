// Row 13 "Test Kitchen" · Block 1 (D-WS9-262) — the Turnstile middleware.
//
// A thin Express wrapper over lib/turnstile.ts's verdict. Reads the token from
// the body (`turnstileToken`), which is where the widget's client puts it, and
// from the `cf-turnstile-response` header as the form-post convention's
// fallback. See lib/turnstile.ts for why this mounts on one route only and why
// it fails closed.

import type { Request, Response, NextFunction } from "express";

import { logger } from "../lib/logger";
import { clientIp } from "../lib/rateLimit";
import {
  verifyTurnstile,
  type TurnstileFetch,
} from "../lib/turnstile";

export interface RequireTurnstileDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: TurnstileFetch;
  timeoutMs: number;
}

function tokenFrom(req: Request): string | undefined {
  const body = req.body as { turnstileToken?: unknown } | undefined;
  if (typeof body?.turnstileToken === "string") return body.turnstileToken;
  const header = req.headers["cf-turnstile-response"];
  if (typeof header === "string") return header;
  return undefined;
}

export function createRequireTurnstile(
  deps: Partial<RequireTurnstileDeps> = {},
) {
  return async function requireTurnstile(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const verdict = await verifyTurnstile({
      token: tokenFrom(req),
      remoteIp: clientIp(req),
      env: deps.env ?? process.env,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
    });
    if (verdict.ok) {
      next();
      return;
    }
    logger.warn(
      { event: "turnstile_refused", reason: verdict.reason },
      "Guest session creation refused by the bot check",
    );
    res.status(403).json({ code: "bot_check_failed" });
  };
}

export const requireTurnstile = createRequireTurnstile();
