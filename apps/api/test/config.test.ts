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
    const token = "t".repeat(24);
    expect(() => loadConfig({ NODE_ENV: "production", SETUP_TOKEN: token })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ NODE_ENV: "production", SETUP_TOKEN: token, DATABASE_URL: "postgres://x" }).production).toBe(
      true,
    );
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/Invalid PORT/);
  });
});

describe("loadConfig network exposure", () => {
  const STRONG_TOKEN = "x".repeat(24);

  it("listens on IPv4 loopback by default, also in production", () => {
    expect(loadConfig({})).toMatchObject({ host: "127.0.0.1", exposed: false });
    expect(
      loadConfig({ NODE_ENV: "production", SETUP_TOKEN: STRONG_TOKEN, DATABASE_URL: "postgres://x" }),
    ).toMatchObject({ host: "127.0.0.1", exposed: false });
  });

  it("treats explicit loopback hosts as not exposed and needs no setup token", () => {
    for (const HOST of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
      expect(loadConfig({ HOST }), HOST).toMatchObject({ host: HOST, exposed: false, setupToken: null });
    }
  });

  it("refuses to expose the API to the network without a setup token", () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20", "my-pc.local"]) {
      expect(() => loadConfig({ HOST }), HOST).toThrow(/Set SETUP_TOKEN/);
    }
  });

  it("allows network exposure only with a strong setup token", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0", SETUP_TOKEN: "short-token" })).toThrow(/at least 24 characters/);
    expect(loadConfig({ HOST: "0.0.0.0", SETUP_TOKEN: STRONG_TOKEN })).toMatchObject({
      host: "0.0.0.0",
      exposed: true,
      setupToken: STRONG_TOKEN,
    });
  });

  it("rejects a weak setup token even on loopback", () => {
    expect(() => loadConfig({ SETUP_TOKEN: "1234" })).toThrow(/at least 24 characters/);
  });
});
