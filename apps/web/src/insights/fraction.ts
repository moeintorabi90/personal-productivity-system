/**
 * Exact non-negative or signed fractions for Stage 6 allocations and targets (DECISIONS "Rounding":
 * calculations keep exact values; only the display rounds to two decimals). Values stay within
 * safe integers for the app's limits (targets up to 10^9, weeks and workdays in the hundreds).
 */
export interface Fraction {
  num: number;
  den: number;
}

const gcd = (a: number, b: number): number => {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
};

export function frac(num: number, den = 1): Fraction {
  if (den === 0) throw new RangeError("division by zero");
  if (den < 0) [num, den] = [-num, -den];
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

export const ZERO: Fraction = { num: 0, den: 1 };
export const add = (a: Fraction, b: Fraction) => frac(a.num * b.den + b.num * a.den, a.den * b.den);
export const sub = (a: Fraction, b: Fraction) => frac(a.num * b.den - b.num * a.den, a.den * b.den);
export const mul = (a: Fraction, b: Fraction) => frac(a.num * b.num, a.den * b.den);
export const div = (a: Fraction, b: Fraction) => frac(a.num * b.den, a.den * b.num);
export const cmp = (a: Fraction, b: Fraction) => Math.sign(a.num * b.den - b.num * a.den);
export const min = (a: Fraction, b: Fraction) => (cmp(a, b) <= 0 ? a : b);
export const max = (a: Fraction, b: Fraction) => (cmp(a, b) >= 0 ? a : b);
export const toNumber = (a: Fraction) => a.num / a.den;
export const isNegative = (a: Fraction) => a.num < 0;

/** Display value: at most two decimals (400/3 → 133.33). */
export function roundForDisplay(a: Fraction): number {
  return Math.round(toNumber(a) * 100) / 100;
}
