import { afterEach, describe, expect, it, vi } from "vitest";
import { putRecord } from "../local/records.ts";
import * as cryptoModule from "./crypto.ts";
import { BackupError } from "./errors.ts";
import { validatePayload } from "./format.ts";
import { canonicalBytes } from "./jcs.ts";
import { MAX_FILE_BYTES } from "./limits.ts";
import { checkBackupFile, openBackupFile } from "./read.ts";
import { PRODUCT_REGISTRY, createRegistry, preferencesType } from "./registry.ts";
import { createTestDevice, fixtureNote, TEST_REGISTRY, type TestDevice } from "./test-fixtures.ts";
import { blobOf, exportFrom, importInto, mutate, rehash, snapshot } from "./test-helpers.ts";
import { z } from "zod";

const devices: TestDevice[] = [];
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of devices.splice(0)) d.db.close();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "OK";
  } catch (error) {
    if (error instanceof BackupError) return error.code;
    throw error;
  }
}

const textToBytes = (text: string) => new TextEncoder().encode(text);

async function plainBackup(): Promise<{ a: TestDevice; text: string }> {
  const a = await device("A");
  await putRecord(a.db, TEST_REGISTRY, "fixtureNote", crypto.randomUUID(), { text: "hello" });
  return { a, text: (await exportFrom(a)).text };
}

describe("9. bad input is refused and the database is unchanged", () => {
  it("refuses truncated, foreign, damaged, invalid, unknown-type, and unresolved files", async () => {
    const { text } = await plainBackup();
    const b = await device("B");
    const before = await snapshot(b.db);
    const parent = crypto.randomUUID();

    const cases: [string, string][] = [
      [text.slice(0, text.length / 2), "INVALID_STRUCTURE"],
      [JSON.stringify({ hello: "world" }), "NOT_A_BACKUP"],
      [mutate(text, (d) => (d.format = "other")), "NOT_A_BACKUP"],
      [mutate(text, (d) => (d.payload.sourceDeviceSettings.theme = "dark"), false), "DAMAGED"],
      [mutate(text, (d) => (d.payload.records.fixtureNote[0].data.text = "")), "INVALID_PAYLOAD"],
      [mutate(text, (d) => (d.payload.records.fixtureNote[0].data.extra = 1)), "INVALID_PAYLOAD"],
      [mutate(text, (d) => (d.payload.records.fixtureNote[0].contentHash = "0".repeat(64))), "INVALID_PAYLOAD"],
      [mutate(text, (d) => (d.payload.records.somethingElse = [])), "UNKNOWN_RECORD_TYPE"],
      [
        mutate(text, (d) => {
          const child = { name: "orphan", parentId: parent };
          d.payload.records.fixtureChild = [
            { ...d.payload.records.fixtureNote[0], id: crypto.randomUUID(), data: child, contentHash: hashOf(child) },
          ];
        }),
        "UNRESOLVED_REFERENCE",
      ],
      [mutate(text, (d) => (d.extra = 1)), "INVALID_HEADER"],
      [mutate(text, (d) => (d.sourceDevice.extra = 1)), "INVALID_HEADER"],
      [mutate(text, (d) => (d.formatVersion = 2)), "NEWER_VERSION"],
      [mutate(text, (d) => (d.app.dataSchemaVersion = 2)), "NEWER_VERSION"],
      ['{"format":"pps-backup",}', "INVALID_STRUCTURE"],
      ['{"format":"pps-backup","n":01}', "INVALID_JSON"],
    ];
    for (const [file, expected] of cases) {
      const code = await codeOf(importInto(b, file));
      expect(code, expected).toBe(expected);
    }
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("10. scope: exports never contain sync_probe data; a file containing it is refused", async () => {
    const a = await device("A");
    await a.db.probes.put({ id: crypto.randomUUID(), text: "diagnostic", serverRevision: 0, createdAt: "x", updatedAt: "x" });
    await a.db.outbox.add({
      opId: crypto.randomUUID(),
      kind: "sync_probe.create",
      recordKey: "k",
      recordId: null,
      baseRevision: 0,
      payload: {},
      status: "pending",
      attempts: 0,
      lastError: null,
      createdAt: "x",
    });
    const file = await exportFrom(a, {}, PRODUCT_REGISTRY);
    expect(file.text).not.toContain("diagnostic");
    expect(file.text).not.toContain("sync_probe");
    expect(Object.keys(JSON.parse(file.text).payload.records)).toEqual(["preferences"]);

    const withProbe = mutate(file.text, (d) => (d.payload.records.sync_probe = [{ text: "x" }]));
    expect(await codeOf(openBackupFile(blobOf(withProbe), PRODUCT_REGISTRY))).toBe("EXCLUDED_DATA");
    const fixtureInProduct = mutate(file.text, (d) => (d.payload.records.fixtureNote = []));
    expect(await codeOf(openBackupFile(blobOf(fixtureInProduct), PRODUCT_REGISTRY))).toBe("UNKNOWN_RECORD_TYPE");
  });
});

function hashOf(data: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:crypto").createHash("sha256").update(canonicalBytes(data)).digest("hex");
}

describe("9a. input limits", () => {
  it("refuses a file over 32 MiB without reading its contents", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    expect(await codeOf(checkBackupFile({ size: MAX_FILE_BYTES + 1, arrayBuffer }))).toBe("FILE_TOO_LARGE");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("accepts a valid file of exactly 32 MiB", async () => {
    const { text } = await plainBackup();
    const padded = text + " ".repeat(MAX_FILE_BYTES - textToBytes(text).length);
    expect(textToBytes(padded).length).toBe(MAX_FILE_BYTES);
    expect(await codeOf(openBackupFile(blobOf(padded), TEST_REGISTRY))).toBe("OK");
  });

  it("enforces the 200,000-entry limit before per-entry validation", () => {
    const base = { records: {}, pendingConflicts: [], replacedVersions: [], sourceDeviceSettings: { language: "en", theme: "system" } };
    const at = (n: number) => ({ ...base, tombstones: Array.from({ length: n }, () => ({})) });
    expect(() => validatePayload(at(200_001), TEST_REGISTRY)).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    // At exactly the limit the count passes; the (empty) entries then fail their own schema.
    expect(() => validatePayload(at(200_000), TEST_REGISTRY)).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
  });

  it("refuses an envelope over 256 KiB and a version vector with 33 devices", async () => {
    const big = createRegistry([
      preferencesType,
      { ...fixtureNote, schema: z.object({ text: z.string() }).strict() as unknown as typeof fixtureNote.schema },
    ]);
    const a = await device("A");
    await putRecord(a.db, big, "fixtureNote", crypto.randomUUID(), { text: "x".repeat(300 * 1024) });
    await expect(exportFrom(a, {}, big)).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });

    const { text } = await plainBackup();
    const tooBig = mutate(text, (d) => {
      const data = { text: "y".repeat(300 * 1024) };
      Object.assign(d.payload.records.fixtureNote[0], { data, contentHash: hashOf(data) });
    });
    expect(await codeOf(openBackupFile(blobOf(tooBig), big))).toBe("LIMIT_EXCEEDED");

    const vector = Object.fromEntries(Array.from({ length: 33 }, () => [crypto.randomUUID(), 1]));
    const wide = mutate(text, (d) => (d.payload.records.fixtureNote[0].version = vector));
    expect(await codeOf(openBackupFile(blobOf(wide), TEST_REGISTRY))).toBe("INVALID_PAYLOAD");
  });
});

describe("9c. the pre-parse scan runs before JSON.parse", () => {
  const bad: [string, string | Uint8Array][] = [
    ["33 levels of nesting", `{"a":${"[".repeat(32)}${"]".repeat(32)}}`],
    ["millions of '['", "[".repeat(4_000_000)],
    ["mismatched brackets", "[}"],
    ["unterminated string", '{"format":"pps-backup'],
    ["control character", '{"format":"pps\u0001"}'],
    ["invalid escape", '{"format":"\\x"}'],
    ["trailing content", '{"format":"pps-backup"} {}'],
    ["more than 4,000,000 values", `[${"0,".repeat(4_000_000)}0]`],
    ["invalid UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])],
  ];
  for (const [name, input] of bad) {
    it(`never calls JSON.parse for ${name}`, async () => {
      const parse = vi.spyOn(JSON, "parse");
      const code = await codeOf(checkBackupFile(new Blob([input as BlobPart])));
      expect(parse).not.toHaveBeenCalled();
      expect(["INVALID_STRUCTURE", "INVALID_UTF8"]).toContain(code);
    });
  }

  it("rejects the same cases inside an encrypted payload before parsing the plaintext", async () => {
    const { a } = await plainBackup();
    const encrypted = (await exportFrom(a, { password: "correct horse" })).text;
    const doc = JSON.parse(encrypted);
    // Re-encrypt a deeply nested plaintext with the same header machinery.
    const prepared = await cryptoModule.prepareEncryption("pw");
    const header = { ...doc, encryption: prepared.encryption };
    delete header.payload;
    delete header.integrity;
    const ciphertext = await cryptoModule.encryptPayload(
      prepared,
      textToBytes("[".repeat(40) + "]".repeat(40)) as Uint8Array<ArrayBuffer>,
      canonicalBytes(header) as Uint8Array<ArrayBuffer>,
    );
    const crafted = rehash({ ...header, payload: { ciphertext } });
    const parse = vi.spyOn(JSON, "parse");
    expect(await codeOf(openBackupFile(blobOf(crafted), TEST_REGISTRY, "pw"))).toBe("INVALID_STRUCTURE");
    expect(parse).toHaveBeenCalledTimes(1); // only the outer file, never the plaintext
  });
});

describe("12. integrity hash", () => {
  it("is SHA-256 over the JCS document without `integrity` (independent check with Node crypto)", async () => {
    const { text } = await plainBackup();
    const doc = JSON.parse(text);
    const expected = doc.integrity.hash;
    expect(JSON.parse(rehash(doc)).integrity.hash).toBe(expected);
  });

  it("reports a damaged encrypted file as damaged before any password prompt or PBKDF2", async () => {
    const { a } = await plainBackup();
    const encrypted = (await exportFrom(a, { password: "pw" })).text;
    const damaged = mutate(encrypted, (d) => (d.payload.ciphertext = `AAAA${d.payload.ciphertext.slice(4)}`), false);
    const kdf = vi.spyOn(cryptoModule.kdf, "deriveKek");
    expect(await codeOf(checkBackupFile(blobOf(damaged)))).toBe("DAMAGED");
    expect(await codeOf(openBackupFile(blobOf(damaged), TEST_REGISTRY, "pw"))).toBe("DAMAGED");
    expect(kdf).not.toHaveBeenCalled();
  });
});
