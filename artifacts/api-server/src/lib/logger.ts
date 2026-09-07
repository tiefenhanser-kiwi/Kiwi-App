import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // BUG-219 — belt and braces. The two call sites that logged a live
    // password-reset / email-change token are fixed at source, but redaction
    // is what stops a FUTURE line from re-leaking one by copying the pattern
    // that used to be there. pino matches these against the merged log object,
    // so they cover a `logger.info({ resetToken, ... })` anywhere in the server.
    "resetToken",
    "resetUrl",
    "verifyToken",
    "verifyUrl",
    "token",
    "authToken",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
