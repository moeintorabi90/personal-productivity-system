import { MAX_JSON_DEPTH, MAX_JSON_VALUES } from "./limits.ts";

export type ScanResult = { ok: true; values: number } | { ok: false; reason: string; position: number };

const OBJECT = 1;
const ARRAY = 2;

// Parser states.
const VALUE = 0; // a value is required
const VALUE_OR_CLOSE = 1; // just after "[": a value or "]"
const KEY_OR_CLOSE = 2; // just after "{": a key or "}"
const KEY = 3; // after "," in an object: a key is required
const COLON = 4; // after a key
const AFTER_VALUE = 5; // after a value: "," or a closing bracket (or end at top level)
const END = 6; // top-level value complete: only whitespace may follow

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/**
 * Structural pre-scan run before JSON.parse (docs/BACKUP_FORMAT.md, "Pre-parse scan").
 * One linear pass, constant memory (a fixed 32-entry bracket stack), no recursion, no objects
 * built. It enforces depth, bracket matching, string syntax, value count, and trailing content;
 * JSON.parse still decides number grammar afterwards.
 */
export function scanJson(
  text: string,
  limits: { maxDepth?: number; maxValues?: number } = {},
): ScanResult {
  const maxDepth = limits.maxDepth ?? MAX_JSON_DEPTH;
  const maxValues = limits.maxValues ?? MAX_JSON_VALUES;
  const stack = new Uint8Array(maxDepth + 1);
  let depth = 0;
  let values = 0;
  let state = VALUE;
  const n = text.length;
  let i = 0;

  const fail = (reason: string): ScanResult => ({ ok: false, reason, position: i });

  /** Scans a string starting at the opening quote; returns the index after the closing quote, or -1. */
  const scanString = (): number => {
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 0x22) return j + 1;
      if (c < 0x20) return -2; // raw control character
      if (c === 0x5c) {
        const e = text.charCodeAt(j + 1);
        if (e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 || e === 0x66 || e === 0x6e || e === 0x72 || e === 0x74) {
          j += 2;
          continue;
        }
        if (e === 0x75) {
          for (let k = 2; k <= 5; k++) if (!isHex(text.charCodeAt(j + k))) return -3;
          j += 6;
          continue;
        }
        return -3; // invalid escape (also covers a backslash at the end of input)
      }
      j++;
    }
    return -1; // unterminated
  };

  const afterValue = () => {
    state = depth === 0 ? END : AFTER_VALUE;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (isWhitespace(c)) {
      i++;
      continue;
    }

    if (state === END) return fail("trailing content after the top-level value");

    if (state === COLON) {
      if (c !== 0x3a) return fail("expected ':'");
      state = VALUE;
      i++;
      continue;
    }

    if (state === AFTER_VALUE) {
      const top = stack[depth];
      if (c === 0x2c) {
        state = top === OBJECT ? KEY : VALUE;
        i++;
        continue;
      }
      if ((c === 0x7d && top === OBJECT) || (c === 0x5d && top === ARRAY)) {
        depth--;
        i++;
        afterValue();
        continue;
      }
      return fail(c === 0x7d || c === 0x5d ? "mismatched closing bracket" : "expected ',' or a closing bracket");
    }

    if (state === KEY_OR_CLOSE || state === KEY) {
      if (state === KEY_OR_CLOSE && c === 0x7d) {
        depth--;
        i++;
        afterValue();
        continue;
      }
      if (c !== 0x22) return fail("expected a string key");
      const end = scanString();
      if (end < 0) return fail(end === -1 ? "unterminated string" : end === -2 ? "control character in string" : "invalid escape");
      i = end;
      state = COLON;
      continue;
    }

    // state is VALUE or VALUE_OR_CLOSE
    if (state === VALUE_OR_CLOSE && c === 0x5d) {
      depth--;
      i++;
      afterValue();
      continue;
    }

    if (++values > maxValues) return fail("too many values");

    if (c === 0x7b || c === 0x5b) {
      if (depth + 1 > maxDepth) return fail("nesting too deep");
      depth++;
      stack[depth] = c === 0x7b ? OBJECT : ARRAY;
      state = c === 0x7b ? KEY_OR_CLOSE : VALUE_OR_CLOSE;
      i++;
      continue;
    }
    if (c === 0x22) {
      const end = scanString();
      if (end < 0) return fail(end === -1 ? "unterminated string" : end === -2 ? "control character in string" : "invalid escape");
      i = end;
      afterValue();
      continue;
    }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      // Number: consume number characters; exact grammar is left to JSON.parse.
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if ((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x65 || d === 0x45 || d === 0x2b || d === 0x2d) i++;
        else break;
      }
      afterValue();
      continue;
    }
    if (text.startsWith("true", i)) i += 4;
    else if (text.startsWith("false", i)) i += 5;
    else if (text.startsWith("null", i)) i += 4;
    else return fail("unexpected character");
    afterValue();
  }

  if (state !== END) return { ok: false, reason: "input ends inside a value", position: i };
  return { ok: true, values };
}
