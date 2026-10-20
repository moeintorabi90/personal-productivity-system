import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { openDatabase } from "./db/open.ts";

const config = loadConfig();
const db = await openDatabase(config);
const report = await migrate(db);
if (report.applied.length) console.log(`Applied migrations: ${report.applied.join(", ")}`);

const server = createApp(db, config).listen(config.port, () => {
  const where = db.kind === "pglite" ? `PGlite at ${config.pgliteDataDir}` : "PostgreSQL";
  console.log(`Sync API listening on http://localhost:${config.port} (${where})`);
  if (!config.setupToken) console.warn("SETUP_TOKEN is not set: owner setup is open to anyone who can reach this server.");
});

async function shutdown(): Promise<void> {
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
