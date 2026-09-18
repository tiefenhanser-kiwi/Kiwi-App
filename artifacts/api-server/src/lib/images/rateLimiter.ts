// Row 5 · Block 1 (D-WS9-246) — a sliding-window rate limiter for the stock
// providers. Pexels allows 200 requests/hour, Pixabay 100 requests/minute;
// each provider instance owns one limiter and awaits `acquire()` before every
// request. When the window is full, acquire() sleeps until the OLDEST request
// in the window ages out, then records the new one — so a full catalog run
// self-paces instead of getting a 429 halfway through the night.
//
// ⚠️ In-process only. Two processes sharing one key would each believe they
// hold the whole budget. That is fine for the batch runner (one process) and
// for Cloud Run at one instance; a second instance is a Block 1c concern.
//
// Clock and sleep are injectable so the tests run without wall-clock waits.

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SlidingWindowRateLimiter {
  private readonly stamps: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  // Serialises concurrent acquirers so two callers cannot both see "one slot
  // left" and both take it.
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) {
      throw new Error("SlidingWindowRateLimiter needs limit > 0 and windowMs > 0");
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  // Resolves when a request may be sent, having recorded it.
  async acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      let at = this.now();
      this.prune(at);
      while (this.stamps.length >= this.limit) {
        const waitMs = this.stamps[0] + this.windowMs - at;
        await this.sleep(Math.max(1, waitMs));
        at = this.now();
        this.prune(at);
      }
      this.stamps.push(at);
    });
    // Keep the chain alive even if a turn throws (it cannot, but be safe).
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  // Diagnostic — how many requests the window currently holds.
  inWindow(): number {
    this.prune(this.now());
    return this.stamps.length;
  }
}

export const PEXELS_RATE = { limit: 200, windowMs: 60 * 60 * 1000 } as const;
export const PIXABAY_RATE = { limit: 100, windowMs: 60 * 1000 } as const;
