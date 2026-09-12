import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import pagesRouter from "./routes/pages";
import { logger } from "./lib/logger";
import { noStore } from "./middleware/cacheControl";
import { errorHandler } from "./middleware/errorHandler";

const app: Express = express();

// BUG-223 — HOW MANY PROXY HOPS DO WE VOUCH FOR? CONFIGURATION, NOT A CONSTANT.
//
// The rate limiter keys on the client address. Until now that was the raw TCP
// peer, and rateLimit.ts documented its own failure: "on a proxied host this
// collapses to a global limit". Behind Cloud Run's front end every request
// arrives from Google, so that is ONE VALUE FOR THE ENTIRE INTERNET —
// authLimiter's 10/min becomes a global 10/min and the first ten people to
// open the beta lock everyone else out for six minutes.
//
// The old code refused to read x-forwarded-for AT ALL, and that reasoning was
// right: any caller can spoof the header to rotate identities and walk around
// the bucket. It stays right for every hop the deploy has not vouched for.
// What changes here is only that the number of vouched-for hops is settable.
//
// ⚠️ DEFAULT 0 = TRUST NOTHING = EXACTLY TODAY'S BEHAVIOUR. Measured: with
// `trust proxy` at 0, req.ip is the socket peer and a spoofed
// x-forwarded-for is ignored — byte-identical to leaving the setting unset.
// So this change is a NO-OP until a deploy sets TRUST_PROXY_HOPS, which is
// what makes it safe to land ahead of the infrastructure.
//
// ⚠️ SET THE HOP COUNT, NEVER `true`. `true` trusts the whole chain and hands
// a spoofer back the very hole the original comment closed. On Cloud Run the
// value is 1: exactly one hop, Google's front end. Measured: at 1, req.ip is
// the LAST entry in the chain (the hop nearest the app), which is the address
// that front end reports and the only one it cannot be tricked about.
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  // Anything that is not a non-negative integer falls back to the safe value.
  // A typo in a deploy variable must not silently widen who we trust.
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

const trustProxyHops = parseTrustProxyHops(process.env["TRUST_PROXY_HOPS"]);
if (process.env["TRUST_PROXY_HOPS"] && trustProxyHops === 0) {
  logger.warn(
    { event: "trust_proxy_hops_invalid", raw: process.env["TRUST_PROXY_HOPS"] },
    "TRUST_PROXY_HOPS is not a non-negative integer — falling back to 0 (trust nothing)",
  );
}
app.set("trust proxy", trustProxyHops);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// Skip the global default-limit JSON parser for routes that mount their own
// larger-limit parser (WS6 6c-2: /api/recipes/import-image uses 35mb). Without
// this guard, the default 100KB parser intercepts first and 413s the request
// before the route-scoped parser runs.
const ROUTE_SCOPED_JSON_PATHS = new Set<string>([
  "/api/recipes/import-image",
]);
const defaultJsonParser = express.json();
app.use((req, res, next) => {
  if (ROUTE_SCOPED_JSON_PATHS.has(req.path)) return next();
  return defaultJsonParser(req, res, next);
});

app.use(express.urlencoded({ extended: true }));

// BUG-104 — no API response may be stored by a platform HTTP cache. Mounted
// on the same path as the router and BEFORE it, so it covers every /api route
// including the unauthenticated ones (health, auth) — a signed-in device
// should not be replaying any of them. Routes needing a different directive
// overwrite it in their own handler (the wizard SSE stream does).
// D-WS9-231 — the reset-password / verify-email web fallback pages live at
// the ROOT of the host (the paths sendEmail.ts::buildAppLink mints), outside
// the /api prefix and therefore outside its auth and API limiters. They set
// their own no-store. Mounted before /api so the ordering is explicit.
app.use(pagesRouter);

app.use("/api", noStore);
app.use("/api", router);

// BUG-103 — terminal error boundary. MUST be the last app.use: Express picks
// error handlers by arity and runs them in mount order, so anything mounted
// after this would never see an error. Backstop only — routes that catch their
// own failures never reach it.
app.use(errorHandler);

export default app;
