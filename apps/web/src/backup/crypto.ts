import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { BackupError } from "./errors.ts";
import type { EncryptionInfo } from "./format.ts";
import { DATA_KEY_BYTES, IV_BYTES, KDF_ITERATIONS_WRITE, SALT_BYTES, TAG_BITS } from "./limits.ts";

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Key derivation. Exposed as an object so tests can spy on it and prove that out-of-bounds
 * parameters are rejected before PBKDF2 ever runs (docs/TESTING.md, item 9b).
 */
export const kdf = {
  /** PBKDF2-SHA-256 over the UTF-8 bytes of the NFC-normalized password → AES-256-GCM key. */
  async deriveKek(password: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFC")), "PBKDF2", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  },
};

async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface PreparedEncryption {
  encryption: EncryptionInfo;
  dataKey: CryptoKey;
  contentIv: Bytes;
}

/** Creates the `encryption` header block (one password slot) and the data key for the payload. */
export async function prepareEncryption(password: string): Promise<PreparedEncryption> {
  const dataKeyBytes = randomBytes(DATA_KEY_BYTES);
  const salt = randomBytes(SALT_BYTES);
  const wrapIv = randomBytes(IV_BYTES);
  const contentIv = randomBytes(IV_BYTES);
  const kek = await kdf.deriveKek(password, salt, KDF_ITERATIONS_WRITE);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, tagLength: TAG_BITS }, kek, dataKeyBytes),
  );
  const encryption: EncryptionInfo = {
    scheme: "pps-enc-1",
    content: { cipher: "AES-256-GCM", iv: bytesToBase64(contentIv), tagBits: 128, aad: "header-jcs" },
    keySlots: [
      {
        type: "password",
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS_WRITE, salt: bytesToBase64(salt) },
        wrap: { cipher: "AES-256-GCM", iv: bytesToBase64(wrapIv) },
        wrappedKey: bytesToBase64(wrapped),
      },
    ],
  };
  return { encryption, dataKey: await aesKey(dataKeyBytes), contentIv };
}

export async function encryptPayload(prepared: PreparedEncryption, plaintext: Bytes, aad: Bytes): Promise<string> {
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: prepared.contentIv, additionalData: aad, tagLength: TAG_BITS },
    prepared.dataKey,
    plaintext,
  );
  return bytesToBase64(new Uint8Array(ciphertext));
}

/**
 * Unwraps the data key with the password and decrypts the payload, authenticating the canonical
 * header as AAD. Parameters must already have been validated (bounds and byte lengths).
 * Any failure means a wrong password or a modified file.
 */
export async function decryptPayload(encryption: EncryptionInfo, ciphertextB64: string, aad: Bytes, password: string): Promise<Bytes> {
  const slot = encryption.keySlots[0]!;
  const salt = base64ToBytes(slot.kdf.salt) as Bytes | null;
  const wrapIv = base64ToBytes(slot.wrap.iv) as Bytes | null;
  const wrappedKey = base64ToBytes(slot.wrappedKey) as Bytes | null;
  const contentIv = base64ToBytes(encryption.content.iv) as Bytes | null;
  const ciphertext = base64ToBytes(ciphertextB64) as Bytes | null;
  if (!salt || !wrapIv || !wrappedKey || !contentIv || !ciphertext) throw new BackupError("INVALID_HEADER", "bad base64");

  const kek = await kdf.deriveKek(password, salt, slot.kdf.iterations);
  let dataKeyBytes: Bytes;
  try {
    dataKeyBytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapIv, tagLength: TAG_BITS }, kek, wrappedKey));
  } catch {
    throw new BackupError("WRONG_PASSWORD");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: contentIv, additionalData: aad, tagLength: TAG_BITS },
      await aesKey(dataKeyBytes),
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new BackupError("WRONG_PASSWORD", "payload authentication failed");
  }
}
