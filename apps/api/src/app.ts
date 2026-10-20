import express from "express";
import type { Config } from "./config.ts";
import type { Db } from "./db/types.ts";
import { errorHandler, notFoundHandler } from "./http/errors.ts";
import { authRoutes } from "./routes/auth.ts";
import { syncRoutes } from "./routes/sync.ts";

export function createApp(db: Db, config: Config): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Set to the number of trusted proxies in front of the API when deployed (affects req.ip for rate limits).
  app.set("trust proxy", false);

  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  app.get("/v1/health", (_req, res) => {
    res.json({ status: "ok", database: db.kind });
  });

  app.use("/v1", authRoutes(db, config));
  app.use("/v1", syncRoutes(db));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
