/**
 * In-memory limiter for failed credential attempts (single-process deployment).
 * Counts only failures; a success clears the key.
 */
export class FailureLimiter {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  constructor(maxFailures = 10, windowMs = 15 * 60 * 1000) {
    this.#maxFailures = maxFailures;
    this.#windowMs = windowMs;
  }

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.#entries.delete(key);
      return false;
    }
    return entry.count >= this.#maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + this.#windowMs });
    } else {
      entry.count += 1;
    }
  }

  clear(key: string): void {
    this.#entries.delete(key);
  }
}
