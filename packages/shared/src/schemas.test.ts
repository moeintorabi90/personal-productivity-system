import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  isValidTimeZone,
  preferencePatchSchema,
  setupRequestSchema,
  syncOperationSchema,
} from "./index.ts";

describe("isValidTimeZone", () => {
  it("accepts IANA names", () => {
    expect(isValidTimeZone("Asia/Tehran")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects raw offsets and unknown zones", () => {
    expect(isValidTimeZone("+03:30")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("preferences", () => {
  it("defaults to English, system theme, Gregorian, Saturday, no time zone", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      language: "en",
      theme: "system",
      calendarDisplay: "gregorian",
      weekStart: 6,
      timeZone: null,
    });
  });

  it("rejects empty and unknown-field patches", () => {
    expect(preferencePatchSchema.safeParse({}).success).toBe(false);
    expect(preferencePatchSchema.safeParse({ ownerId: "x" }).success).toBe(false);
    expect(preferencePatchSchema.safeParse({ language: "fa" }).success).toBe(true);
  });
});

describe("setupRequestSchema", () => {
  it("normalizes email and requires a long password", () => {
    const device = { id: "6f1c2b7e-8a4d-4f7b-9c3e-1a2b3c4d5e6f", name: "Laptop" };
    const ok = setupRequestSchema.parse({ email: " Owner@Example.TEST ", password: "a".repeat(12), device });
    expect(ok.email).toBe("owner@example.test");
    expect(setupRequestSchema.safeParse({ email: "owner@example.test", password: "short", device }).success).toBe(false);
  });
});

describe("syncOperationSchema", () => {
  const opId = "0b7f5a0e-6d1c-4a9a-8d43-3f2b1c0d9e8a";
  const recordId = "c3d9b1e2-7f6a-4b5c-8d9e-0a1b2c3d4e5f";

  it("parses each kind", () => {
    expect(syncOperationSchema.parse({ opId, kind: "sync_probe.create", recordId, payload: { text: "hi" } }).kind).toBe(
      "sync_probe.create",
    );
    expect(syncOperationSchema.parse({ opId, kind: "sync_probe.delete", recordId, baseRevision: 2 }).kind).toBe(
      "sync_probe.delete",
    );
    expect(
      syncOperationSchema.parse({ opId, kind: "preferences.update", baseRevision: 1, payload: { theme: "dark" } }).kind,
    ).toBe("preferences.update");
  });

  it("requires a base revision for updates", () => {
    expect(syncOperationSchema.safeParse({ opId, kind: "sync_probe.update", recordId, payload: { text: "x" } }).success).toBe(
      false,
    );
  });
});
