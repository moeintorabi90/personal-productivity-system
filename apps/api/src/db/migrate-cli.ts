import { loadConfig } from "../config.ts";
import { migrate } from "./migrate.ts";
import { openDatabase } from "./open.ts";

const config = loadConfig();
const db = await openDatabase(config);
try {
  const report = await migrate(db);
  console.log(`Database: ${db.kind}${db.kind === "pglite" ? ` (${config.pgliteDataDir})` : ""}`);
  console.log(`Applied: ${report.applied.length ? report.applied.join(", ") : "none"}`);
  console.log(`Already applied: ${report.alreadyApplied.length}`);
} finally {
  await db.close();
}
