import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64DecodedLength, base64ToBytes, bytesToBase64 } from "./base64.ts";
import { canonicalize } from "./jcs.ts";
import { scanJson } from "./scan.ts";
import { sha256Hex } from "./sha256.ts";
import { compareVersions, mergeAndBump } from "./versions.ts";

describe("JCS (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units and removes whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "€": 0, "\u0080": 0 })).toBe('{"a":[true,null,"x"],"b":1,"\u0080":0,"€":0}');
  });

  it("serializes numbers like ECMAScript", () => {
    expect(canonicalize([1e21, 1e-7, -0, 0.1, 100, 333333333.3333333])).toBe("[1e+21,1e-7,0,0.1,100,333333333.3333333]");
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalize("a\u000f\"\\ ")).toBe('"a\\u000f\\"\\\\ "');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
  });
});

describe("SHA-256 (synchronous)", () => {
  it("matches Node's implementation on several lengths", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 100_000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(bytes), `length ${length}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
});

describe("base64", () => {
  it("round-trips and computes decoded length", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    const text = bytesToBase64(bytes);
    expect(base64ToBytes(text)).toEqual(bytes);
    expect(base64DecodedLength(text)).toBe(bytes.length);
    expect(base64ToBytes("abc")).toBeNull();
    expect(base64ToBytes("a$c=")).toBeNull();
  });
});

describe("version vectors", () => {
  it("orders, detects concurrency, and merges", () => {
    expect(compareVersions({}, { a: 1 })).toBe("before");
    expect(compareVersions({ a: 2 }, { a: 1 })).toBe("after");
    expect(compareVersions({ a: 1, b: 1 }, { a: 1, b: 1 })).toBe("equal");
    expect(compareVersions({ a: 2 }, { b: 1 })).toBe("concurrent");
    expect(mergeAndBump({ a: 2 }, { a: 1, b: 3 }, "a")).toEqual({ a: 3, b: 3 });
  });
});

describe("pre-parse scan", () => {
  const nest = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

  it("accepts 32 levels and rejects 33", () => {
    expect(scanJson(nest(32))).toMatchObject({ ok: true });
    expect(scanJson(nest(33))).toMatchObject({ ok: false, reason: "nesting too deep" });
  });

  it("rejects millions of opening brackets early, without recursion", () => {
    const text = "[".repeat(8_000_000);
    const result = scanJson(text);
    expect(result).toMatchObject({ ok: false, reason: "nesting too deep" });
    expect((result as { position: number }).position).toBe(32);
  });

  it("rejects mismatched brackets, bad strings, and trailing content", () => {
    expect(scanJson("[}").ok).toBe(false);
    expect(scanJson("{]").ok).toBe(false);
    expect(scanJson('["abc')).toMatchObject({ ok: false, reason: "unterminated string" });
    expect(scanJson('["a\u0001b"]')).toMatchObject({ ok: false, reason: "control character in string" });
    expect(scanJson('["a\\qb"]')).toMatchObject({ ok: false, reason: "invalid escape" });
    expect(scanJson('["\\u12G4"]')).toMatchObject({ ok: false, reason: "invalid escape" });
    expect(scanJson("{} {}")).toMatchObject({ ok: false, reason: "trailing content after the top-level value" });
    expect(scanJson('{"a":1')).toMatchObject({ ok: false, reason: "input ends inside a value" });
    expect(scanJson('{"a" 1}').ok).toBe(false);
    expect(scanJson("[1,]").ok).toBe(false);
    expect(scanJson("[tru]").ok).toBe(false);
  });

  it("does not count brackets inside strings toward depth", () => {
    const text = `{"a":"${"[".repeat(1000)}{{{"}`;
    expect(scanJson(text)).toMatchObject({ ok: true, values: 2 });
  });

  it("counts values (keys excluded) and enforces the 4,000,000 limit", () => {
    expect(scanJson('{"a":[1,"x",true,null,{}]}')).toMatchObject({ ok: true, values: 7 });
    const exactly = `[${"0,".repeat(3_999_998)}0]`; // 1 array + 3,999,999 numbers
    expect(scanJson(exactly)).toMatchObject({ ok: true, values: 4_000_000 });
    const over = `[${"0,".repeat(3_999_999)}0]`;
    expect(scanJson(over)).toMatchObject({ ok: false, reason: "too many values" });
  });

  it("leaves number grammar to JSON.parse", () => {
    expect(scanJson("[01]").ok).toBe(true);
    expect(() => JSON.parse("[01]")).toThrow();
  });
});
