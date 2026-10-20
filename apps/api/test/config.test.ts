import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("defaults PGlite data to local app data, outside the repository", () => {
    const config = loadConfig({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" });
    expect(config.pgliteDataDir).toBe(path.join("C:\\Users\\x\\AppData\\Local", "PersonalProductivitySystem", "pglite-dev"));
    expect(config.port).toBe(8787);
    expect(config.setupToken).toBeNull();
  });

  it("refuses to start in production without a setup token or PostgreSQL URL", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://x" })).toThrow(/SETUP_TOKEN/);
    expect(() => loadConfig({ NODE_ENV: "production", SETUP_TOKEN: "t" })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ NODE_ENV: "production", SETUP_TOKEN: "t", DATABASE_URL: "postgres://x" }).production).toBe(true);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/Invalid PORT/);
  });
});
