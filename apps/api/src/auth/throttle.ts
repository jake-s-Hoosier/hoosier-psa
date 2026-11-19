/**
 * In-memory sign-in throttling. Kept in memory on purpose: it works in read-only environments (the
 * database cannot be written there) and a restart only forgives, never locks. One API process runs per
 * environment today; move this into the database if that changes.
 */
interface Bucket {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockMs = 15 * 60 * 1000,
  ) {}

  /** Seconds until the key may try again, or 0. */
  lockedFor(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    return b && b.lockedUntil > now ? Math.ceil((b.lockedUntil - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()): void {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    b.count += 1;
    if (b.count >= this.maxFailures) b.lockedUntil = now + this.lockMs;
  }

  succeed(key: string): void {
    this.buckets.delete(key);
  }
}
