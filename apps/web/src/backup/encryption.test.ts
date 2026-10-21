import { afterEach, describe, expect, it, vi } from "vitest";
import { putRecord } from "../local/records.ts";
import * as cryptoModule from "./crypto.ts";
import { BackupError } from "./errors.ts";
import { checkBackupFile, openBackupFile } from "./read.ts";
import { createTestDevice, TEST_REGISTRY, type TestDevice } from "./test-fixtures.ts";
import { blobOf, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

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

const PRECOMPOSED = "آبی"; // آبی with U+0622
const DECOMPOSED = "آبی"; // same text, U+0627 U+0653 (canonically equivalent)

let shared: { text: string; source: TestDevice } | undefined;
async function encryptedFile(): Promise<{ text: string; source: TestDevice }> {
  if (shared) return shared;
  const source = await createTestDevice("source");
  await putRecord(source.db, TEST_REGISTRY, "fixtureNote", crypto.randomUUID(), { text: "secret note" });
  shared = { text: (await exportFrom(source, { password: PRECOMPOSED + "-pass" })).text, source };
  return shared;
}

describe("13. optional password encryption (D-014)", () => {
  it("default export is unencrypted; a password produces one password key slot and no plaintext", async () => {
    const a = await device("A");
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", crypto.randomUUID(), { text: "secret note" });
    const plain = JSON.parse((await exportFrom(a)).text);
    expect(plain.encryption).toBeNull();
    const { text } = await encryptedFile();
    const doc = JSON.parse(text);
    expect(doc.encryption.keySlots).toHaveLength(1);
    expect(doc.encryption.keySlots[0]).toMatchObject({ type: "password", kdf: { iterations: 600_000, hash: "SHA-256" } });
    expect(doc.encryption.hint).toBeUndefined();
    expect(text).not.toContain("secret note");
  });

  it("round-trips with the right password; a wrong one changes nothing", async () => {
    const { text } = await encryptedFile();
    const b = await device("B");
    const before = await snapshot(b.db);
    expect(await codeOf(checkBackupFile(blobOf(text)))).toBe("OK"); // header checks need no password
    expect(await codeOf(openBackupFile(blobOf(text), TEST_REGISTRY))).toBe("PASSWORD_REQUIRED");
    expect(await codeOf(importInto(b, text, { password: "wrong" }))).toBe("WRONG_PASSWORD");
    expect(await snapshot(b.db)).toEqual(before);
    const { result } = await importInto(b, text, { password: PRECOMPOSED + "-pass" });
    expect(result.counts.new).toBe(1);
  });

  it("NFC: a canonically equivalent password works; Arabic Yeh instead of Persian Yeh is a different password", async () => {
    const { text } = await encryptedFile();
    expect(await codeOf(openBackupFile(blobOf(text), TEST_REGISTRY, DECOMPOSED + "-pass"))).toBe("OK");
    const arabicYeh = PRECOMPOSED.replace("ی", "ي") + "-pass";
    expect(arabicYeh).not.toBe(PRECOMPOSED + "-pass");
    expect(await codeOf(openBackupFile(blobOf(text), TEST_REGISTRY, arabicYeh))).toBe("WRONG_PASSWORD");
  });

  it("modified ciphertext, IV, salt, iteration count, or header field fails authentication", async () => {
    const { text } = await encryptedFile();
    const flip = (b64: string) => (b64[0] === "A" ? "B" : "A") + b64.slice(1);
    const changes: ((d: any) => void)[] = [
      (d) => (d.payload.ciphertext = flip(d.payload.ciphertext)),
      (d) => (d.encryption.content.iv = flip(d.encryption.content.iv)),
      (d) => (d.encryption.keySlots[0].kdf.salt = flip(d.encryption.keySlots[0].kdf.salt)),
      (d) => (d.encryption.keySlots[0].kdf.iterations = 600_001),
      (d) => (d.createdAt = "2001-01-01T00:00:00.000Z"),
      (d) => (d.sourceDevice.name = "someone else"),
    ];
    for (const change of changes) {
      // The integrity hash is recomputed, so only authenticated encryption can catch these.
      const tampered = mutate(text, change);
      expect(await codeOf(openBackupFile(blobOf(tampered), TEST_REGISTRY, PRECOMPOSED + "-pass"))).toBe("WRONG_PASSWORD");
    }
  }, 60_000);
});

describe("9b. KDF parameters are checked before the password prompt and before PBKDF2", () => {
  it("refuses out-of-bounds or malformed encryption parameters without running PBKDF2", async () => {
    const { text } = await encryptedFile();
    const slot = (d: any) => d.encryption.keySlots[0];
    const bad: [string, (d: any) => void][] = [
      ["iterations 599,999", (d) => (slot(d).kdf.iterations = 599_999)],
      ["iterations 1,000,001", (d) => (slot(d).kdf.iterations = 1_000_001)],
      ["non-integer iterations", (d) => (slot(d).kdf.iterations = 600_000.5)],
      ["salt not 16 bytes", (d) => (slot(d).kdf.salt = "AAAA")],
      ["IV not 12 bytes", (d) => (d.encryption.content.iv = "AAAAAAAA")],
      ["wrap IV not 12 bytes", (d) => (slot(d).wrap.iv = "AAAAAAAAAAAAAAAAAAAAAAAA")],
      ["wrappedKey not 48 bytes", (d) => (slot(d).wrappedKey = "AAAA")],
      ["zero key slots", (d) => (d.encryption.keySlots = [])],
      ["two key slots", (d) => d.encryption.keySlots.push(structuredClone(slot(d)))],
      ["recoveryKey slot", (d) => (slot(d).type = "recoveryKey")],
      ["hint field", (d) => (d.encryption.hint = "my cat")],
      ["unknown cipher", (d) => (d.encryption.content.cipher = "AES-128-CBC")],
      ["unknown hash", (d) => (slot(d).kdf.hash = "SHA-1")],
    ];
    const kdf = vi.spyOn(cryptoModule.kdf, "deriveKek");
    for (const [name, change] of bad) {
      const file = mutate(text, change);
      expect(await codeOf(checkBackupFile(blobOf(file))), name).toBe("INVALID_HEADER");
      expect(await codeOf(openBackupFile(blobOf(file), TEST_REGISTRY, PRECOMPOSED + "-pass")), name).toBe("INVALID_HEADER");
    }
    expect(kdf).not.toHaveBeenCalled();
  });

  it("accepts the boundary values 600,000 and 1,000,000 at the header check", async () => {
    const { text } = await encryptedFile();
    for (const iterations of [600_000, 1_000_000]) {
      const file = mutate(text, (d) => (d.encryption.keySlots[0].kdf.iterations = iterations));
      expect(await codeOf(checkBackupFile(blobOf(file)))).toBe("OK");
    }
  });
});
