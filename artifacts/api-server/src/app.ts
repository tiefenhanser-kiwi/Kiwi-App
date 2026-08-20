import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { noStore } from "./middleware/cacheControl";
import { errorHandler } from "./middleware/errorHandler";

const app: Express = express();

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
app.use("/api", noStore);
app.use("/api", router);

// BUG-103 — terminal error boundary. MUST be the last app.use: Express picks
// error handlers by arity and runs them in mount order, so anything mounted
// after this would never see an error. Backstop only — routes that catch their
// own failures never reach it.
app.use(errorHandler);

export default app;
