import express, { type NextFunction, type Request, type Response } from "express";
import { type Config, LOOPBACK_HOSTS } from "./config.ts";
import type { Db } from "./db/types.ts";
import { ApiError, errorHandler, notFoundHandler } from "./http/errors.ts";

/** Host name from a Host header value: "localhost:8787" → "localhost", "[::1]:8787" → "::1". */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : null;
  }
  return value.split(":")[0] || null;
}

/**
 * When bound to loopback, accept only requests addressed to a loopback name. This blocks
 * DNS-rebinding attacks, where a web page on an attacker's domain that resolves to 127.0.0.1
 * would otherwise reach this API (and the open first-run setup) as a same-origin request.
 */
function requireLoopbackHostHeader(req: Request, _res: Response, next: NextFunction): void {
  const hostname = hostnameOf(req.get("host"));
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
    next(new ApiError(403, "HOST_NOT_ALLOWED", "This server only accepts requests addressed to localhost."));
    return;
  }
  next();
}
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
  if (!config.exposed) app.use(requireLoopbackHostHeader);
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
