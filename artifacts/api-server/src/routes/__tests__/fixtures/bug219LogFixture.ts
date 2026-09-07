// BUG-219 guard fixture — NOT a test file (lives under fixtures/ so it does not
// match the `src/routes/__tests__/*.test.ts` glob in package.json:test).
//
// Runs in a CHILD PROCESS on purpose. `logger` is a pino instance writing to
// fd 1 through SonicBoom, so patching `process.stdout.write` in-process does
// NOT see its output — the only way to assert on what the real logger really
// emits is to capture the child's stdout. NODE_ENV=production is set by the
// parent so pino skips the pino-pretty worker transport and emits plain JSON
// synchronously, which is also exactly the production shape we care about.
import express, { type Express } from "express";
import type { Server } from "node:http";

import { logger } from "../../../lib/logger";
import { createAuthRouter } from "../../auth";

const mode = process.argv[2];

// Stub prisma — no database. The reset handler only needs findUnique to
// return a user so it reaches the mint-and-log branch under test.
const prisma = {
  user: {
    findUnique: async () => ({
      id: "bug219-fixture-user",
      email: "bug219@example.test",
    }),
  },
} as unknown as never;

async function runHandler(): Promise<void> {
  const app: Express = express();
  app.use(express.json());
  app.use(createAuthRouter({ prisma }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };

  const res = await fetch(`http://127.0.0.1:${port}/auth/password-reset/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "bug219@example.test" }),
  });
  // Surface the status on stderr so the parent can prove the handler actually
  // ran the success branch rather than 400ing before it ever logged.
  process.stderr.write(`STATUS=${res.status}\n`);
  await new Promise<void>((r) => server.close(() => r()));
}

function runRedact(): void {
  // Belt-and-braces path: log the exact field names the redact list names,
  // through the REAL logger, and let the parent assert they come out censored.
  logger.info(
    {
      event: "bug219_redact_probe",
      resetToken: "eyJ.FIXTURE.RESET",
      resetUrl: "kiwi://reset-password?token=eyJ.FIXTURE.RESET",
      verifyToken: "eyJ.FIXTURE.VERIFY",
      verifyUrl: "kiwi://verify-email?token=eyJ.FIXTURE.VERIFY",
      token: "eyJ.FIXTURE.BARE",
      authToken: "eyJ.FIXTURE.AUTH",
    },
    "redact probe",
  );
}

async function main(): Promise<void> {
  if (mode === "handler") await runHandler();
  else if (mode === "redact") runRedact();
  else throw new Error(`unknown mode: ${mode}`);
  // Let the sync destination drain before the process goes away.
  await new Promise((r) => setTimeout(r, 150));
}

main().catch((err) => {
  process.stderr.write(`FIXTURE_ERROR ${String(err)}\n`);
  process.exit(1);
});
