import type { Request, Response, NextFunction } from "express";

import { verifyToken } from "../lib/auth";

// Augment Express Request to include userId after successful auth.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing or invalid authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  // WS7-2 Block A: require session purpose so a stray password-reset or
  // email-change token can't authenticate API requests.
  const payload = verifyToken(token, "session");
  if (!payload) {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }

  req.userId = payload.userId;
  next();
}
