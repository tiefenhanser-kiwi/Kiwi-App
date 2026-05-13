import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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

app.use("/api", router);

export default app;
