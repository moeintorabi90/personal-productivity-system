/**
 * JSON Canonicalization Scheme (RFC 8785). In JavaScript, JCS equals JSON.stringify for
 * primitives (ECMAScript number and string serialization), with object keys sorted by UTF-16
 * code units (the default Array.prototype.sort order) and no whitespace.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const entries = Object.keys(value as object)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

const encoder = new TextEncoder();

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}
