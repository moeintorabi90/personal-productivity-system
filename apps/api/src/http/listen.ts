import type { Server } from "node:http";
import type { Express } from "express";
import type { Config } from "../config.ts";

/** Starts the HTTP server on the configured interface (127.0.0.1 unless HOST is set). */
export function listen(app: Express, config: Pick<Config, "host" | "port">): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}
