import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { openDatabase } from "./db/open.ts";
import { listen } from "./http/listen.ts";

const config = loadConfig();
const db = await openDatabase(config);
const report = await migrate(db);
if (report.applied.length) console.log(`Applied migrations: ${report.applied.join(", ")}`);

const server = await listen(createApp(db, config), config);
const { address, port } = server.address() as AddressInfo;
const where = db.kind === "pglite" ? `PGlite at ${config.pgliteDataDir}` : "PostgreSQL";
const shown = address.includes(":") ? `[${address}]` : address;
console.log(`Sync API listening on http://${shown}:${port} (${where})`);
if (config.exposed) {
  console.warn(`HOST=${config.host}: the API is reachable from other devices on the network. Owner setup requires SETUP_TOKEN.`);
} else {
  console.log("Listening on loopback only; set HOST to allow other devices (requires SETUP_TOKEN).");
}
if (!config.setupToken) console.warn("SETUP_TOKEN is not set: owner setup is open to any program on this machine.");

async function shutdown(): Promise<void> {
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
